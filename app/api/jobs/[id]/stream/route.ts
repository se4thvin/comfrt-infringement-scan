import { getJob, snapshot } from '@/lib/jobs/store';
import type { JobEvent } from '@/lib/scraper/types';

export const dynamic = 'force-dynamic';

/* SSE endpoint. Subscribes to a job: replays everything so far, then streams
 * live events. The job is NOT owned by this connection — refresh/reconnect
 * replays state and resumes. Heartbeat comment every 15s keeps proxies from
 * reaping the connection during quiet stretches. */

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const job = getJob(params.id);
  if (!job) {
    return new Response('job not found (server restarted? jobs are in-memory)', { status: 404 });
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: JobEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* controller already closed */ }
      };

      // Replay for late/reconnecting subscribers
      for (const ev of snapshot(job)) send(ev);

      if (job.done) {
        try { controller.close(); } catch {}
        return;
      }

      const onEvent = (ev: JobEvent) => {
        send(ev);
        if (ev.type === 'done') {
          cleanup?.();
          try { controller.close(); } catch {}
        }
      };
      job.emitter.on('event', onEvent);

      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch {}
      }, 15_000);

      cleanup = () => {
        job.emitter.off('event', onEvent);
        clearInterval(heartbeat);
        cleanup = null;
      };
    },
    cancel() {
      // Client went away: end this subscription. The job keeps running.
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
