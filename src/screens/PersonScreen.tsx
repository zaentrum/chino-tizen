// Person / Filmography surface for the Tizen TV shell. Rail + top-bar chrome
// (parity with Search / Browse), a header — the portrait (initials without
// one), the name and the number of titles, then what the catalog knows about
// them: known for, born (date, age, birthplace), died, and the biography —
// then a focusable poster grid of their titles, each naming the person's roles
// on it. ENTER on a card opens that title's Detail; BACK pops back to the
// originating surface (search results or the Detail page a name was picked
// on). Parity with chino-web's PersonPage (usePerson, lib/people, lib/credits)
// and chino-androidtv's PersonScreen.
//
// Data: GET /v1/people/{id} via api.getPerson — the flat PersonDetail, the
// biography asked for in the TV's languages. The portrait (profile_url) is
// served like a poster, from the stream-token group, so it carries ?stream=.
//
// D-pad: the first title takes focus on entry, the page staying at its top so
// the header shows. When the biography is cut short, UP reaches "Read more",
// which opens it whole in an overlay that UP/DOWN scroll; BACK closes the
// overlay first, then leaves the page.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PersonDetail } from '@/api/types';
import { api } from '@/api/instance';
import SideRail from '@/components/SideRail';
import TopBar from '@/components/TopBar';
import FocusableCard from '@/components/FocusableCard';
import Spinner from '@/components/Spinner';
import { PersonAvatar } from '@/components/PersonAvatar';
import { formatRoles } from '@/lib/credits';
import { ageInYears, formatCatalogDate, todayCatalogDate } from '@/lib/people';
import { useRoute, navigate, back } from '@/router';
import { focusKey, useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';

type PersonState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; person: PersonDetail };

/** focusKey of "Read more", to land on it again when the overlay closes. */
const READ_MORE_KEY = 'person:read-more';

export default function PersonScreen(): JSX.Element {
  const { params } = useRoute();
  const personId = params.id ?? '';
  const [state, setState] = useState<PersonState>({ kind: 'loading' });
  // Stream token authorises the poster + portrait <img> URLs (best-effort;
  // they fall back to placeholders / initials if it never arrives).
  const [streamToken, setStreamToken] = useState<string | undefined>(undefined);

  // BACK returns to the previous surface (search results / the Detail page the
  // name was picked on). The biography overlay subscribes after this, so it
  // gets BACK first while it is open.
  useRemoteKey(TVKey.BACK, () => back());

  useEffect(() => {
    let alive = true;
    void api
      .streamToken()
      .then((t) => {
        if (alive) setStreamToken(t);
      })
      .catch(() => {
        /* artwork falls back to the placeholders */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    if (personId === '') {
      setState({ kind: 'error', message: 'No person selected.' });
      return;
    }
    api
      .getPerson(personId)
      .then((person) => {
        if (alive) setState({ kind: 'ready', person });
      })
      .catch((e: unknown) => {
        if (alive) {
          setState({ kind: 'error', message: e instanceof Error ? e.message : "Couldn't load person" });
        }
      });
    return () => {
      alive = false;
    };
  }, [personId]);

  return (
    <div className="flex h-screen w-full bg-bg text-text">
      <SideRail active="person" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex-1 overflow-y-auto px-10 py-6">
          {state.kind === 'loading' ? <Spinner label="Loading…" fullscreen={false} /> : null}
          {state.kind === 'error' ? (
            <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
              <p className="text-2xl font-semibold text-red">Couldn’t load person</p>
              <p className="text-muted">{state.message}</p>
            </div>
          ) : null}
          {state.kind === 'ready' ? (
            <PersonView person={state.person} streamToken={streamToken} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The header + the focusable filmography grid. */
function PersonView({
  person,
  streamToken,
}: {
  person: PersonDetail;
  streamToken?: string;
}): JSX.Element {
  const [bioOpen, setBioOpen] = useState(false);
  const items = person.items ?? [];
  // The titles listed, else the server's count when the list came back empty.
  const credits = items.length || person.credits || 0;
  // The portrait once the token that authorises it is there (a request
  // without it would only 401); initials until then, and without one.
  const portrait =
    person.has_profile && streamToken ? api.assetUrl(person.profile_url, streamToken) : undefined;
  const facts = personFacts(person);
  const biography = person.biography?.trim();

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-start gap-10">
        <PersonAvatar
          name={person.name}
          src={portrait}
          size={person.has_profile ? 192 : 128}
          portrait={!!person.has_profile}
        />
        <div className="min-w-0 max-w-5xl flex-1">
          <h1 className="text-5xl font-bold text-text">{person.name}</h1>
          <p className="mt-2 text-lg text-muted">{creditLabel(credits)}</p>
          {facts.length > 0 ? (
            <div className="mt-6 grid grid-cols-3 gap-x-10 gap-y-4 text-lg">
              {facts.map((f) => (
                <div key={f.label} className="min-w-0">
                  <div className="mb-1 text-muted">{f.label}</div>
                  {f.lines.map((line) => (
                    <div key={line} className="break-words text-text">
                      {line}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
          {biography ? (
            <Biography
              text={biography}
              lang={person.biography_lang}
              onReadMore={() => setBioOpen(true)}
            />
          ) : null}
        </div>
      </div>

      <section>
        <h2 className="mb-4 text-2xl font-semibold text-text">Filmography</h2>
        {items.length === 0 ? (
          <p className="text-muted">No titles for {person.name}.</p>
        ) : (
          <div className="flex flex-wrap gap-4 py-2">
            {items.map((item, i) => (
              <FocusableCard
                key={item.id}
                item={item}
                streamToken={streamToken}
                // The first title takes focus, but the page stays at its top:
                // the header (portrait, name, facts) is what entry shows.
                autoFocus={i === 0}
                autoFocusScroll={false}
                credit={formatRoles(item.roles) || undefined}
                onEnter={() => navigate(`/detail/${item.id}`)}
              />
            ))}
          </div>
        )}
      </section>

      {bioOpen && biography ? (
        <BiographyOverlay
          name={person.name}
          text={biography}
          lang={person.biography_lang}
          onClose={() => {
            setBioOpen(false);
            // Back on "Read more" once the overlay is gone, not wherever the
            // engine would land next.
            window.setTimeout(() => focusKey(READ_MORE_KEY), 0);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The labelled facts under the name, as chino-web lists them: what they are
 * known for, when and where they were born (with their age), when they died
 * (with the age they reached). Dates in the TV's locale ("March 3, 1957").
 */
function personFacts(p: PersonDetail): { label: string; lines: string[] }[] {
  const facts: { label: string; lines: string[] }[] = [];
  if (p.known_for_department) facts.push({ label: 'Known for', lines: [p.known_for_department] });
  const born = formatCatalogDate(p.birth_date);
  const died = formatCatalogDate(p.death_date);
  const age = ageInYears(p.birth_date, p.death_date || todayCatalogDate());
  if (born || p.birthplace) {
    const lines: string[] = [];
    if (born) lines.push(!died && age !== undefined ? `${born} (age ${age})` : born);
    if (p.birthplace) lines.push(p.birthplace);
    facts.push({ label: 'Born', lines });
  }
  if (died) facts.push({ label: 'Died', lines: [age !== undefined ? `${died} (aged ${age})` : died] });
  return facts;
}

/** The biography, cut to five lines; "Read more" (only when it is in fact
 *  cut) opens it whole. In its own language, for hyphenation. */
function Biography({
  text,
  lang,
  onReadMore,
}: {
  text: string;
  lang?: string;
  onReadMore: () => void;
}): JSX.Element {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    // Fonts arriving late reflow the text; re-measure where the runtime can.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className="mt-6">
      <p
        ref={ref}
        lang={lang || undefined}
        className="line-clamp-5 whitespace-pre-line text-lg leading-relaxed text-text"
      >
        {text}
      </p>
      {clamped ? <ReadMore onEnter={onReadMore} /> : null}
    </div>
  );
}

function ReadMore({ onEnter }: { onEnter: () => void }): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, focusKey: READ_MORE_KEY });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`mt-3 inline-flex cursor-default select-none items-center gap-2 px-4 py-2 text-lg ${
        focused ? 'bg-white text-black' : 'bg-white/10 text-accent'
      }`}
    >
      Read more
      <ChevronDown className="h-5 w-5" />
    </div>
  );
}

/** The whole biography over the page. UP/DOWN scroll it, LEFT/RIGHT stay in
 *  it (the page's cards are behind it), ENTER on Close or BACK closes it. */
function BiographyOverlay({
  name,
  text,
  lang,
  onClose,
}: {
  name: string;
  text: string;
  lang?: string;
  onClose: () => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const close = useFocusable({ onEnter: onClose, autoFocus: true });
  useRemoteKey([TVKey.UP, TVKey.DOWN, TVKey.LEFT, TVKey.RIGHT], (e) => {
    e.preventDefault();
    const el = scrollRef.current;
    const code = e.keyCode || e.which;
    if (!el || (code !== TVKey.UP && code !== TVKey.DOWN)) return;
    el.scrollTop += (code === TVKey.DOWN ? 1 : -1) * Math.round(el.clientHeight * 0.6);
  });
  useRemoteKey(TVKey.BACK, (e) => {
    e.preventDefault();
    onClose();
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85">
      <div className="flex max-h-[85vh] w-[64rem] flex-col gap-6 border border-border-2 bg-surface p-10">
        <h2 className="text-3xl font-semibold text-text">{name}</h2>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-4">
          <p lang={lang || undefined} className="whitespace-pre-line text-xl leading-relaxed text-text">
            {text}
          </p>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-base text-muted">Up / Down to scroll</span>
          <div
            ref={close.ref}
            data-focused={close.focused}
            className={`cursor-default select-none px-6 py-2 text-lg font-semibold ${
              close.focused ? 'bg-white text-black' : 'bg-white/10 text-white'
            }`}
          >
            Close
          </div>
        </div>
      </div>
    </div>
  );
}

/** "N titles", singular at 1. Matches the Search people-row label. */
function creditLabel(credits: number): string {
  return credits === 1 ? '1 title' : `${credits} titles`;
}
