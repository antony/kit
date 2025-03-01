declare namespace App {
	interface Locals {
		answer: number;
		name: string;
		key: string;
		params: Record<string, string>;
	}

	interface Platform {}

	interface Session {
		answer?: number;
		calls?: number;
	}

	interface Stuff {
		message: string;
		error: string;
		page: string;
		value: number;
		x: string;
		y: string;
	}
}
