import { NextResponse } from 'next/server'
import { getEngine } from '../../../lib/engine'

export async function POST(req: Request): Promise<NextResponse> {
  let prompt: unknown
  try {
    prompt = (await req.json() as { prompt?: unknown }).prompt
  } catch {
    return NextResponse.json({ error: 'body must be JSON {"prompt": "..."}' }, { status: 400 })
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  }
  getEngine().startRun(prompt.trim())
  return NextResponse.json({ started: true, prompt: prompt.trim() }, { status: 202 })
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ engine: 'armed', model: getEngine() ? (process.env.OI_MODEL_PATH ?? '(heuristic)') : 'failed' })
}