import { connect } from 'cloudflare:sockets';

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/socket' && request.method === 'POST') {
			return fcless(url, request, env, ctx);
		}
		return new Response('404 Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;


async function fcless(url: URL, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const hostName = url.searchParams.get('hostname');
	const port = url.searchParams.get('port');
	if (!hostName || !port) {
		return new Response('hostname and port query parameters are required', { status: 400 });
	}
	// 校验端口号是否合法
	const portNumber = parseInt(port);
	if (isNaN(portNumber) || portNumber < 1 || portNumber > 65535) {
		return new Response('port must be a number between 1 and 65535', { status: 400 });
	}
	// 校验请求体是否存在
	if (!request.body) {
		return new Response('Request body is required', { status: 400 });
	}
	console.log(`Connecting to ${hostName}:${portNumber}`);
	try {
		// 连接到目标服务器
		const tcpSocket = connect({
			hostname: hostName,
			port: portNumber,
		});
		await tcpSocket.opened;
		request.body.pipeTo(tcpSocket.writable).catch((error) => {
			console.error('Error piping request body to target server:', error);
			tcpSocket.close();
		});
		return new Response(tcpSocket.readable, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error('Error connecting to target server:', error);
		return new Response('Failed to connect to target server', { status: 502 });
	}
}
