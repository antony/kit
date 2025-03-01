import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import colors from 'kleur';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import * as vite from 'vite';
import { mkdirp, posixify, rimraf } from '../utils/filesystem.js';
import * as sync from '../core/sync/sync.js';
import { build_server } from './build/build_server.js';
import { build_service_worker } from './build/build_service_worker.js';
import { load_config } from '../core/config/index.js';
import { dev } from './dev/index.js';
import { generate_manifest } from '../core/generate_manifest/index.js';
import { get_runtime_directory, logger } from '../core/utils.js';
import { find_deps, get_default_config as get_default_build_config } from './build/utils.js';
import { preview } from './preview/index.js';
import { get_aliases, resolve_entry, prevent_illegal_rollup_imports } from './utils.js';
import { fileURLToPath } from 'node:url';

const cwd = process.cwd();

/** @type {import('./types').EnforcedConfig} */
const enforced_config = {
	appType: true,
	base: true,
	build: {
		cssCodeSplit: true,
		emptyOutDir: true,
		lib: {
			entry: true,
			name: true,
			formats: true
		},
		manifest: true,
		outDir: true,
		polyfillModulePreload: true,
		rollupOptions: {
			input: true,
			output: {
				format: true,
				entryFileNames: true,
				chunkFileNames: true,
				assetFileNames: true
			},
			preserveEntrySignatures: true
		},
		ssr: true
	},
	publicDir: true,
	resolve: {
		alias: {
			$app: true,
			$lib: true,
			'$service-worker': true
		}
	},
	root: true
};

/**
 * @return {import('vite').Plugin[]}
 */
export function sveltekit() {
	return [...svelte(), kit()];
}

/**
 * Returns the SvelteKit Vite plugin. Vite executes Rollup hooks as well as some of its own.
 * Background reading is available at:
 * - https://vitejs.dev/guide/api-plugin.html
 * - https://rollupjs.org/guide/en/#plugin-development
 *
 * You can get an idea of the lifecycle by looking at the flow charts here:
 * - https://rollupjs.org/guide/en/#build-hooks
 * - https://rollupjs.org/guide/en/#output-generation-hooks
 *
 * @return {import('vite').Plugin}
 */
function kit() {
	/** @type {import('types').ValidatedConfig} */
	let svelte_config;

	/** @type {import('vite').ResolvedConfig} */
	let vite_config;

	/** @type {import('vite').ConfigEnv} */
	let vite_config_env;

	/** @type {import('types').ManifestData} */
	let manifest_data;

	/** @type {boolean} */
	let is_build;

	/** @type {import('types').Logger} */
	let log;

	/** @type {import('types').Prerendered} */
	let prerendered;

	/** @type {import('types').BuildData} */
	let build_data;

	/** @type {Set<string>} */
	let illegal_imports;

	/** @type {string | undefined} */
	let deferred_warning;

	/**
	 * @type {{
	 *   build_dir: string;
	 *   output_dir: string;
	 *   client_out_dir: string;
	 * }}
	 */
	let paths;

	let completed_build = false;

	function vite_client_build_config() {
		/** @type {Record<string, string>} */
		const input = {
			// Put unchanging assets in immutable directory. We don't set that in the
			// outDir so that other plugins can add mutable assets to the bundle
			start: `${get_runtime_directory(svelte_config.kit)}/client/start.js`
		};

		// This step is optional — Vite/Rollup will create the necessary chunks
		// for everything regardless — but it means that entry chunks reflect
		// their location in the source code, which is helpful for debugging
		manifest_data.components.forEach((file) => {
			const resolved = path.resolve(cwd, file);
			const relative = decodeURIComponent(path.relative(svelte_config.kit.files.routes, resolved));

			const name = relative.startsWith('..')
				? path.basename(file)
				: posixify(path.join('pages', relative));
			input[name] = resolved;
		});

		return get_default_build_config({
			config: svelte_config,
			input,
			ssr: false,
			outDir: `${paths.client_out_dir}`
		});
	}

	/**
	 * @param {import('rollup').OutputAsset[]} assets
	 * @param {import('rollup').OutputChunk[]} chunks
	 */
	function client_build_info(assets, chunks) {
		/** @type {import('vite').Manifest} */
		const vite_manifest = JSON.parse(
			fs.readFileSync(`${paths.client_out_dir}/manifest.json`, 'utf-8')
		);

		const entry_id = posixify(
			path.relative(cwd, `${get_runtime_directory(svelte_config.kit)}/client/start.js`)
		);

		return {
			assets,
			chunks,
			entry: find_deps(vite_manifest, entry_id, false),
			vite_manifest
		};
	}

	// TODO remove this for 1.0
	check_vite_version();

	return {
		name: 'vite-plugin-svelte-kit',

		/**
		 * Build the SvelteKit-provided Vite config to be merged with the user's vite.config.js file.
		 * @see https://vitejs.dev/guide/api-plugin.html#config
		 */
		async config(config, config_env) {
			vite_config_env = config_env;
			svelte_config = await load_config();
			is_build = config_env.command === 'build';

			paths = {
				build_dir: `${svelte_config.kit.outDir}/build`,
				output_dir: `${svelte_config.kit.outDir}/output`,
				client_out_dir: `${svelte_config.kit.outDir}/output/client/`
			};

			illegal_imports = new Set([
				`${svelte_config.kit.outDir}/runtime/env/dynamic/private.js`,
				`${svelte_config.kit.outDir}/runtime/env/static/private.js`
			]);

			if (is_build) {
				manifest_data = sync.all(svelte_config, config_env.mode).manifest_data;

				const new_config = vite_client_build_config();

				const warning = warn_overridden_config(config, new_config);
				if (warning) console.error(warning + '\n');

				return new_config;
			}

			// dev and preview config can be shared
			/** @type {import('vite').UserConfig} */
			const result = {
				appType: 'custom',
				base: '/',
				build: {
					rollupOptions: {
						// Vite dependency crawler needs an explicit JS entry point
						// eventhough server otherwise works without it
						input: `${get_runtime_directory(svelte_config.kit)}/client/start.js`
					}
				},
				define: {
					__SVELTEKIT_DEV__: 'true',
					__SVELTEKIT_APP_VERSION_POLL_INTERVAL__: '0'
				},
				publicDir: svelte_config.kit.files.assets,
				resolve: {
					alias: get_aliases(svelte_config.kit)
				},
				root: cwd,
				server: {
					fs: {
						allow: [
							...new Set([
								svelte_config.kit.files.lib,
								svelte_config.kit.files.routes,
								svelte_config.kit.outDir,
								path.resolve(cwd, 'src'),
								path.resolve(cwd, 'node_modules'),
								path.resolve(vite.searchForWorkspaceRoot(cwd), 'node_modules')
							])
						]
					},
					watch: {
						ignored: [
							// Ignore all siblings of config.kit.outDir/generated
							`${posixify(svelte_config.kit.outDir)}/!(generated)`
						]
					}
				}
			};

			deferred_warning = warn_overridden_config(config, result);
			return result;
		},

		/**
		 * Stores the final config.
		 */
		configResolved(config) {
			vite_config = config;
		},

		/**
		 * Clears the output directories.
		 */
		buildStart() {
			// Reset for new build. Goes here because `build --watch` calls buildStart but not config
			completed_build = false;

			if (is_build) {
				rimraf(paths.build_dir);
				mkdirp(paths.build_dir);

				rimraf(paths.output_dir);
				mkdirp(paths.output_dir);
			}
		},

		/**
		 * Vite builds a single bundle. We need three bundles: client, server, and service worker.
		 * The user's package.json scripts will invoke the Vite CLI to execute the client build. We
		 * then use this hook to kick off builds for the server and service worker.
		 */
		async writeBundle(_options, bundle) {
			for (const file of manifest_data.components) {
				const id = path.resolve(file);
				const node = this.getModuleInfo(id);

				if (node) {
					prevent_illegal_rollup_imports(
						this.getModuleInfo.bind(this),
						node,
						illegal_imports,
						svelte_config.kit.outDir
					);
				}
			}

			const verbose = vite_config.logLevel === 'info';
			log = logger({
				verbose
			});

			fs.writeFileSync(
				`${paths.client_out_dir}/${svelte_config.kit.appDir}/version.json`,
				JSON.stringify({ version: svelte_config.kit.version.name })
			);

			const { assets, chunks } = collect_output(bundle);
			log.info(`Client build completed. Wrote ${chunks.length} chunks and ${assets.length} assets`);

			log.info('Building server');
			const options = {
				cwd,
				config: svelte_config,
				vite_config,
				vite_config_env,
				build_dir: paths.build_dir, // TODO just pass `paths`
				manifest_data,
				output_dir: paths.output_dir,
				service_worker_entry_file: resolve_entry(svelte_config.kit.files.serviceWorker)
			};
			const client = client_build_info(assets, chunks);
			const server = await build_server(options, client);

			/** @type {import('types').BuildData} */
			build_data = {
				app_dir: svelte_config.kit.appDir,
				manifest_data,
				service_worker: options.service_worker_entry_file ? 'service-worker.js' : null, // TODO make file configurable?
				client,
				server
			};

			const manifest_path = `${paths.output_dir}/server/manifest.js`;
			fs.writeFileSync(
				manifest_path,
				`export const manifest = ${generate_manifest({
					build_data,
					relative_path: '.',
					routes: manifest_data.routes
				})};\n`
			);

			log.info('Prerendering');
			await new Promise((fulfil, reject) => {
				const results_path = `${svelte_config.kit.outDir}/generated/prerendered.json`;

				// do prerendering in a subprocess so any dangling stuff gets killed upon completion
				const script = fileURLToPath(
					new URL(
						process.env.BUNDLED ? './prerender.js' : '../core/prerender/prerender.js',
						import.meta.url
					)
				);

				const child = fork(
					script,
					[vite_config.build.outDir, results_path, manifest_path, '' + verbose],
					{
						stdio: 'inherit'
					}
				);

				child.on('exit', (code) => {
					if (code) {
						reject(new Error(`Prerendering failed with code ${code}`));
					} else {
						prerendered = JSON.parse(fs.readFileSync(results_path, 'utf8'), (key, value) => {
							if (key === 'pages' || key === 'assets' || key === 'redirects') {
								return new Map(value);
							}
							return value;
						});
						fulfil(undefined);
					}
				});
			});

			if (options.service_worker_entry_file) {
				if (svelte_config.kit.paths.assets) {
					throw new Error('Cannot use service worker alongside config.kit.paths.assets');
				}

				log.info('Building service worker');

				await build_service_worker(options, prerendered, client.vite_manifest);
			}

			console.log(
				`\nRun ${colors.bold().cyan('npm run preview')} to preview your production build locally.`
			);

			completed_build = true;
		},

		/**
		 * Runs the adapter.
		 */
		async closeBundle() {
			if (!completed_build) {
				// vite calls closeBundle when dev-server restarts, ignore that,
				// and only adapt when build successfully completes.
				return;
			}

			if (svelte_config.kit.adapter) {
				const { adapt } = await import('../core/adapt/index.js');
				await adapt(svelte_config, build_data, prerendered, { log });
			} else {
				console.log(colors.bold().yellow('\nNo adapter specified'));
				// prettier-ignore
				console.log(
					`See ${colors.bold().cyan('https://kit.svelte.dev/docs/adapters')} to learn how to configure your app to run on the platform of your choosing`
				);
			}
		},

		/**
		 * Adds the SvelteKit middleware to do SSR in dev mode.
		 * @see https://vitejs.dev/guide/api-plugin.html#configureserver
		 */
		async configureServer(vite) {
			// This method is called by Vite after clearing the screen.
			// This patch ensures we can log any important messages afterwards for the user to see.
			const print_urls = vite.printUrls;
			vite.printUrls = function () {
				print_urls.apply(this);
				if (deferred_warning) console.error('\n' + deferred_warning);
			};

			return await dev(vite, vite_config, svelte_config, illegal_imports);
		},

		/**
		 * Adds the SvelteKit middleware to do SSR in preview mode.
		 * @see https://vitejs.dev/guide/api-plugin.html#configurepreviewserver
		 */
		configurePreviewServer(vite) {
			return preview(vite, vite_config, svelte_config);
		}
	};
}

function check_vite_version() {
	// TODO parse from kit peer deps and maybe do a full semver compare if we ever require feature releases a min
	const min_required_vite_major = 3;
	const vite_version = vite.version ?? '2.x'; // vite started exporting it's version in 3.0
	const current_vite_major = parseInt(vite_version.split('.')[0], 10);

	if (current_vite_major < min_required_vite_major) {
		throw new Error(
			`Vite version ${current_vite_major} is no longer supported. Please upgrade to version ${min_required_vite_major}`
		);
	}
}

/** @param {import('rollup').OutputBundle} bundle */
function collect_output(bundle) {
	/** @type {import('rollup').OutputChunk[]} */
	const chunks = [];
	/** @type {import('rollup').OutputAsset[]} */
	const assets = [];
	for (const value of Object.values(bundle)) {
		// collect asset and output chunks
		if (value.type === 'asset') {
			assets.push(value);
		} else {
			chunks.push(value);
		}
	}
	return { assets, chunks };
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} resolved_config
 */
function warn_overridden_config(config, resolved_config) {
	const overridden = find_overridden_config(config, resolved_config, enforced_config, '', []);

	if (overridden.length > 0) {
		return (
			colors.bold().red('The following Vite config options will be overridden by SvelteKit:') +
			overridden.map((key) => `\n  - ${key}`).join('')
		);
	}
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} resolved_config
 * @param {import('./types').EnforcedConfig} enforced_config
 * @param {string} path
 * @param {string[]} out used locally to compute the return value
 */
function find_overridden_config(config, resolved_config, enforced_config, path, out) {
	for (const key in enforced_config) {
		if (typeof config === 'object' && config !== null && key in config) {
			const enforced = enforced_config[key];

			if (enforced === true) {
				if (config[key] !== resolved_config[key]) {
					out.push(path + key);
				}
			} else {
				find_overridden_config(config[key], resolved_config[key], enforced, path + key + '.', out);
			}
		}
	}

	return out;
}
