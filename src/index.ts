import { connect } from 'cloudflare:sockets';

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/socket') {
			return await fclessTunnel(url, request, env);
		}
		if (url.pathname === '/dns') {
			return await fclessDns(url, request, env);
		}
		return new Response('404 Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;


/**
 * 处理DNS解析请求，将DNS查询转发到对应的DNS服务器，并将DNS服务器的响应转发回客户端
 */
async function fclessDns(url: URL, request: Request, env: Env): Promise<Response> {
	return await fetch('https://cloudflare-dns.com/dns-query' + url.search, {
		method: request.method,
		headers: request.headers,
		body: request.body,
	});
}


/**
 * 将连接请求转发到对应的Durable Object实例，并将Durable Object实例的响应转发回客户端
 */
async function fclessTunnel(url: URL, request: Request, env: Env): Promise<Response> {
	if (request.method === 'GET') {
		try {
			const sessionId = crypto.randomUUID();
			const stub = env.TUNNELS.get(env.TUNNELS.idFromName(sessionId));
			const connectUrl = new URL('https://tunnel/socket');
			connectUrl.search = url.search;
			const tunnelResponse = await stub.fetch(connectUrl, { 
				method: 'GET', 
				// duplex: 'half', 
			});
			return new Response(tunnelResponse.body, {
				status: tunnelResponse.status,
				headers: {
					'X-Fcless-Session-Id': sessionId,
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'no-store',
					'X-Content-Type-Options': 'nosniff',
				}
			});
		} catch (error) {
			return new Response(`Failed to open tunnel : ${error}`, { status: 502 });
		}
	}
	if (request.method === 'POST') {
		try {
			const sessionId = url.searchParams.get('sessionId');
			if (!sessionId) {
				return new Response('sessionId query parameter is required', { status: 400 });
			}
			const stub = env.TUNNELS.get(env.TUNNELS.idFromName(sessionId));
			const targetUrl = new URL(`https://tunnel/socket`);
			return await stub.fetch(new Request(targetUrl, {
				method: 'POST',
				// duplex: 'half', 
				body: request.body,
				headers: {
					'Content-Type': 'application/octet-stream'
				}
			}));
		} catch (error) {
			return new Response(`Failed to forward to tunnel : ${error}`, { status: 502 });
		}
	}
	return new Response('Method Not Allowed', { status: 405 });
}


export class TunnelSession {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) { }
	private writable?: WritableStream;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST') {
			if (!this.writable) {
				return new Response('Tunnel not opened', { status: 404 });
			}
			const writable = this.writable;
			this.writable = undefined;
			try {
				if(!request.body){
					return new Response('Request body is required', { status: 400 });
				}
				await request.body.pipeTo(writable);
				return new Response(null, { status: 204 });
			} catch (error) {
				return new Response(`Failed to forward to tunnel : ${error}`, { status: 502 });
			}
		}
		if (request.method === 'GET') {
			const hostName = url.searchParams.get('hostname');
			const port = parsePort(url.searchParams.get('port'));
			if (!hostName || !port) {
				return new Response('hostname and port query parameters are required', { status: 400 });
			}
			let tcpSocket;
			try {
				tcpSocket = connect({
					hostname: hostName,
					port: port,
				});
				await tcpSocket.opened;
				this.writable = tcpSocket.writable;
				return new Response(tcpSocket.readable, {
					status: 200,
					headers: {
						'Content-Type': 'application/octet-stream',
						'Cache-Control': 'no-store',
						'X-Content-Type-Options': 'nosniff',
					}
				});
			} catch (error) {
				void tcpSocket?.close().catch(() => { });
				return new Response(`Failed to connect to target server ${error}`, { status: 502 });
			}
		}
		return new Response('404 Not Found', { status: 404 });
	}
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
