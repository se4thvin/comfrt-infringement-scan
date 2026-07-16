import { NextResponse } from 'next/server';
import { createJob } from '@/lib/jobs/store';
import { runJob } from '@/lib/jobs/runJob';

export const dynamic = 'force-dynamic';

export async function POST() {
  const job = createJob();
  // Detached: the job's lifetime is NOT tied to any HTTP connection.
  runJob(job).catch((e) => console.error(`[job ${job.id}] crashed:`, e));
  return NextResponse.json({ jobId: job.id });
}
