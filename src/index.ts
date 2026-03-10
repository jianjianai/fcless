import { connect } from 'cloudflare:sockets';

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/socket/open' && request.method === 'POST') {
			return openTunnel(url, env);
		}

		if (url.pathname === '/socket/upload' && request.method === 'POST') {
			return forwardToTunnel(url, request, env, '/upload');
		}

		if (url.pathname === '/socket/download' && request.method === 'GET') {
			return forwardToTunnel(url, request, env, '/download');
		}

		return new Response('404 Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function openTunnel(url: URL, env: Env): Promise<Response> {
	const hostName = url.searchParams.get('hostname');
	const port = parsePort(url.searchParams.get('port'));
	if (!hostName || !port) {
		return new Response('hostname and port query parameters are required', { status: 400 });
	}

	const sessionId = crypto.randomUUID();
	const stub = env.TUNNELS.get(env.TUNNELS.idFromName(sessionId));
	const openUrl = new URL('https://tunnel/open');
	openUrl.searchParams.set('hostname', hostName);
	openUrl.searchParams.set('port', String(port));

	const response = await stub.fetch(openUrl, { method: 'POST' });
	if (!response.ok) {
		const message = await response.text().catch(() => 'Failed to open tunnel');
		return new Response(message || 'Failed to open tunnel', { status: response.status || 502 });
	}

	return Response.json({ sessionId });
}

async function forwardToTunnel(url: URL, request: Request, env: Env, path: '/upload' | '/download'): Promise<Response> {
	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) {
		return new Response('sessionId query parameter is required', { status: 400 });
	}

	const stub = env.TUNNELS.get(env.TUNNELS.idFromName(sessionId));
	const targetUrl = new URL(`https://tunnel${path}`);
	return stub.fetch(new Request(targetUrl, request));
}

function parsePort(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		return undefined;
	}

	return parsed;
}

export class TunnelSession {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) { }

	private tcpSocket: ReturnType<typeof connect> | undefined;
	private uploadActive = false;
	private downloadActive = false;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/open' && request.method === 'POST') {
			return this.handleOpen(url);
		}

		if (url.pathname === '/upload' && request.method === 'POST') {
			return this.handleUpload(request);
		}

		if (url.pathname === '/download' && request.method === 'GET') {
			return this.handleDownload();
		}

		return new Response('404 Not Found', { status: 404 });
	}

	private async handleOpen(url: URL): Promise<Response> {
		if (this.tcpSocket) {
			return new Response('Tunnel already opened', { status: 409 });
		}

		const hostName = url.searchParams.get('hostname');
		const port = parsePort(url.searchParams.get('port'));
		if (!hostName || !port) {
			return new Response('hostname and port query parameters are required', { status: 400 });
		}

		console.log(`Connecting to ${hostName}:${port}`);
		try {
			this.tcpSocket = connect({
				hostname: hostName,
				port,
			});
			void this.tcpSocket.closed.finally(() => {
				this.tcpSocket = undefined;
				this.uploadActive = false;
				this.downloadActive = false;
			});
			await this.tcpSocket.opened;
			return new Response(null, { status: 204 });
		} catch (error) {
			console.error('Error connecting to target server:', error);
			this.tcpSocket = undefined;
			return new Response('Failed to connect to target server', { status: 502 });
		}
	}

	private async handleUpload(request: Request): Promise<Response> {
		if (!this.tcpSocket) {
			return new Response('Tunnel not opened', { status: 404 });
		}

		if (this.uploadActive) {
			return new Response('Upload already active', { status: 409 });
		}

		if (!request.body) {
			return new Response('Request body is required', { status: 400 });
		}

		this.uploadActive = true;
		try {
			await request.body.pipeTo(this.tcpSocket.writable);
			return new Response(null, { status: 204 });
		} catch (error) {
			console.error('Error piping request body to target server:', error);
			this.tcpSocket.close();
			return new Response('Failed to write to target server', { status: 502 });
		} finally {
			this.uploadActive = false;
		}
	}

	private handleDownload(): Response {
		if (!this.tcpSocket) {
			return new Response('Tunnel not opened', { status: 404 });
		}

		if (this.downloadActive) {
			return new Response('Download already active', { status: 409 });
		}

		this.downloadActive = true;
		void this.tcpSocket.closed.finally(() => {
			this.downloadActive = false;
		});

		return new Response(this.tcpSocket.readable, {
			status: 200,
			headers: {
				'Content-Type': 'application/octet-stream',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
			},
		});
	}
}
