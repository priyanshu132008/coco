import Link from 'next/link'
import AnatomyCanvas from '../components/AnatomyCanvas'

/** Landing page — one column of type beside the system's anatomy, the way a magazine opens. */
export default function Page(): React.ReactElement {
  return (
    <div className="relative min-h-screen px-6 pb-32 pt-10 sm:px-10 lg:px-16">
      <header>
        <Link href="/" className="font-serif text-lg tracking-tight text-ink">
          Coco
        </Link>
      </header>

      <div className="grid min-h-[80vh] grid-cols-1 items-center gap-8 lg:grid-cols-12">
        <main className="lg:col-span-7">
          <div className="max-w-2xl lg:mt-24">
            <h1 className="font-serif text-[2.5rem] leading-[1.12] tracking-tight text-ink sm:text-[3.5rem]">
              Coco is an autonomous personal assistant that lives in your chat and acts on your behalf.
            </h1>

            <p className="mt-10 max-w-xl font-sans text-lg leading-relaxed text-ink-muted">
              The interface is invisible. You don&rsquo;t need to learn a new app or dashboard. Just text it.
            </p>

            <p className="mt-6 max-w-xl font-sans text-lg leading-relaxed text-ink-muted">
              It can <Under>order groceries for the week</Under>, <Under>book a flight to Delhi</Under>,{' '}
              <Under>find the cheapest protein powder</Under>, or <Under>pay your utility bills</Under>.
            </p>

            <Link
              href="/setup"
              className="mt-14 inline-block font-sans text-base text-ink decoration-1 underline-offset-[6px] transition-opacity duration-200 hover:opacity-60"
            >
              Deploy Coco&nbsp;&rarr;
            </Link>
          </div>
        </main>

        <div className="lg:col-span-5">
          <AnatomyCanvas />
        </div>
      </div>

      <footer className="absolute bottom-8 left-6 right-6 sm:left-10 lg:left-16">
        <p className="font-sans text-xs text-ink-muted">Coco | Privacy | Terms</p>
      </footer>
    </div>
  )
}

/** A thin, quiet underline — the bracketed capabilities read as a list, not as chrome. */
function Under({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="text-ink decoration-[1px] underline-offset-[3px] underline decoration-ink/40">
      {children}
    </span>
  )
}
