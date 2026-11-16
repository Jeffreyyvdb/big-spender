import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export type Prompter = {
	ask(question: string): Promise<string>;
	/** Like `ask`, without echoing what is typed. */
	askHidden(question: string): Promise<string>;
	close(): void;
};

export function createPrompter(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout
): Prompter {
	let muted = false;
	const echo = new Writable({
		write(chunk, _encoding, done) {
			if (!muted) output.write(chunk);
			done();
		}
	});
	const rl = createInterface({
		input,
		output: echo,
		terminal: Boolean((input as { isTTY?: boolean }).isTTY)
	});
	const lines = rl[Symbol.asyncIterator]();

	async function read(question: string, hidden: boolean): Promise<string> {
		output.write(question);
		muted = hidden;
		try {
			const next = await lines.next();
			if (next.done) throw new Error('no input: stdin closed while waiting for an answer');
			return next.value.trim();
		} finally {
			muted = false;
			if (hidden) output.write('\n');
		}
	}

	return {
		ask: (question) => read(question, false),
		askHidden: (question) => read(question, true),
		close: () => rl.close()
	};
}
