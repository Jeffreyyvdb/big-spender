import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { DeviceConfig } from './devices.ts';
import { renderPage } from './page.ts';
import { createBigSpender, type BigSpender } from './server/index.ts';

export type ServeConfig = {
	port: number;
	host: string;
	dataDir: string;
	ingestToken: string | undefined;
	adminToken: string | undefined;
	devices: DeviceConfig;
};

const deviceConfigSchema = z.strictObject({
	devices: z.record(
		z.string(),
		z.strictObject({ name: z.string().min(1), color: z.string().min(1) })
	),
	unknownDevices: z.enum(['by-id', 'other']).optional()
});

const DEFAULT_DEVICES: DeviceConfig = { devices: {}, unknownDevices: 'by-id' };

export const SERVE_USAGE = `Usage: big-spender serve [--port 8787] [--host 0.0.0.0] [--data ./data] [--devices devices.json]

Environment:
  PORT, HOST                     listen address (flags win)
  BIG_SPENDER_DATA_DIR           where per-device snapshots are stored (default ./data)
  BIG_SPENDER_INGEST_TOKEN       bearer token collectors must send; ingest is off without it
  BIG_SPENDER_ADMIN_TOKEN        bearer token for GET /api/usage/limits/hits; must differ from the ingest token; off without it
  BIG_SPENDER_DEVICES_FILE       JSON device names and colours (see the README)`;

export async function loadServeConfig(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env
): Promise<ServeConfig> {
	const { values } = parseArgs({
		args: argv,
		options: {
			port: { type: 'string' },
			host: { type: 'string' },
			data: { type: 'string' },
			devices: { type: 'string' }
		},
		strict: true
	});

	const rawPort = values.port ?? env.PORT ?? '8787';
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`invalid port "${rawPort}"`);
	}

	const devicesFile = values.devices ?? env.BIG_SPENDER_DEVICES_FILE;
	let devices = DEFAULT_DEVICES;
	if (devicesFile) {
		const parsed = deviceConfigSchema.safeParse(JSON.parse(await readFile(devicesFile, 'utf8')));
		if (!parsed.success) {
			const issues = parsed.error.issues.map(
				(i) => `${i.path.join('.') || '(root)'}: ${i.message}`
			);
			throw new Error(`invalid devices file ${devicesFile}: ${issues.join('; ')}`);
		}
		devices = parsed.data;
	}

	return {
		port,
		host: values.host ?? env.HOST ?? '0.0.0.0',
		dataDir: values.data ?? env.BIG_SPENDER_DATA_DIR ?? './data',
		ingestToken: env.BIG_SPENDER_INGEST_TOKEN?.trim() || undefined,
		adminToken: env.BIG_SPENDER_ADMIN_TOKEN?.trim() || undefined,
		devices
	};
}

const SECURITY_HEADERS = {
	'x-content-type-options': 'nosniff',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"
};

type Route = { methods: string[]; handle: (bs: BigSpender, request: Request) => Promise<Response> };

const routes: Record<string, Route> = {
	'/api/usage/ingest': { methods: ['POST'], handle: (bs, request) => bs.ingest(request) },
	'/api/usage': {
		methods: ['GET', 'HEAD'],
		handle: async (bs) =>
			Response.json(await bs.summary(), {
				headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=900' }
			})
	},
	'/api/usage/limits': {
		methods: ['GET', 'HEAD'],
		handle: async (bs) =>
			Response.json(await bs.limits(), {
				headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=900' }
			})
	},
	'/api/usage/limits/hits': {
		methods: ['GET', 'HEAD'],
		handle: (bs, request) => bs.limitHits(request)
	},
	'/': {
		methods: ['GET', 'HEAD'],
		handle: async (bs) =>
			new Response(renderPage(await bs.summary(), await bs.limits()), {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
			})
	},
	'/healthz': { methods: ['GET', 'HEAD'], handle: async () => new Response('ok\n') }
};

function toRequest(req: IncomingMessage): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		for (const v of Array.isArray(value) ? value : [value])
			if (v !== undefined) headers.append(name, v);
	}
	const method = req.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	return new Request(`http://localhost${req.url ?? '/'}`, {
		method,
		headers,
		body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
		duplex: 'half'
	} as RequestInit);
}

async function respond(bs: BigSpender, req: IncomingMessage): Promise<Response> {
	const path = (req.url ?? '/').split('?')[0];
	const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
	if (!route) return Response.json({ error: 'not found' }, { status: 404 });
	const method = req.method ?? 'GET';
	if (!route.methods.includes(method)) {
		return Response.json(
			{ error: 'method not allowed' },
			{ status: 405, headers: { allow: route.methods.join(', ') } }
		);
	}
	return route.handle(bs, toRequest(req));
}

async function send(res: ServerResponse, response: Response, head: boolean): Promise<void> {
	const headers: Record<string, string> = { ...SECURITY_HEADERS };
	response.headers.forEach((value, name) => (headers[name] = value));
	const body = Buffer.from(await response.arrayBuffer());
	headers['content-length'] = String(body.length);
	res.writeHead(response.status, headers);
	res.end(head ? undefined : body);
}

export function createHttpServer(bs: BigSpender): Server {
	return createServer((req, res) => {
		respond(bs, req)
			.catch((err) => {
				console.error('[big-spender] request failed:', err);
				return Response.json({ error: 'internal error' }, { status: 500 });
			})
			.then((response) => send(res, response, req.method === 'HEAD'))
			.catch(() => res.destroy());
	});
}

export async function serve(argv: string[]): Promise<void> {
	const config = await loadServeConfig(argv);
	const bs = createBigSpender(config);
	const server = createHttpServer(bs);
	if (!config.ingestToken) {
		console.warn('[big-spender] BIG_SPENDER_INGEST_TOKEN is not set: ingest is disabled (503)');
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(config.port, config.host, resolve);
	});
	console.log(
		`big-spender listening on http://${config.host}:${config.port} (data: ${config.dataDir})`
	);

	const stop = () => {
		server.close(() => process.exit(0));
		server.closeAllConnections();
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}
