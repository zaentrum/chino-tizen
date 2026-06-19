// Person / Filmography surface for the Tizen TV shell. Rail + top-bar chrome
// (parity with Search / Browse), a header (initials-avatar + name + "· N
// titles"), then a focusable poster grid of the person's credited titles
// rendered with the shared FocusableCard. ENTER on a card opens that title's
// Detail; BACK pops back to the originating surface (search results or the
// Detail page a cast name was tapped from). Mirrors chino-androidtv
// ui/person/PersonScreen.kt + PersonViewModel.kt and chino-web's usePerson hook.
//
// Data: GET /v1/people/{id} via api.getPerson, which normalises the flat wire
// shape into { person, items }. The returned items are standard catalogue Items
// (poster/watched/progress), so the shared card renders them with no special
// casing. Credit count = the filmography length (the full list of titles the
// person is credited on), matching the reference VM.

import { useEffect, useState } from 'react';
import { User as UserIcon } from 'lucide-react';
import type { Item, Person } from '@/api/types';
import { api } from '@/api/instance';
import SideRail from '@/components/SideRail';
import TopBar from '@/components/TopBar';
import FocusableCard from '@/components/FocusableCard';
import Spinner from '@/components/Spinner';
import { useRoute, navigate, back } from '@/router';
import { useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';

type PersonState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; person: Person; items: Item[] };

export default function PersonScreen(): JSX.Element {
  const { params } = useRoute();
  const personId = params.id ?? '';
  const [state, setState] = useState<PersonState>({ kind: 'loading' });
  // Stream token authorises the poster <img> URLs (best-effort; posters fall
  // back to a placeholder if it never arrives).
  const [streamToken, setStreamToken] = useState<string | undefined>(undefined);

  // BACK returns to the previous surface (search results / the Detail page the
  // name was tapped from). The history stack already holds it, so just pop.
  useRemoteKey(TVKey.BACK, () => back());

  useEffect(() => {
    let alive = true;
    void api
      .streamToken()
      .then((t) => {
        if (alive) setStreamToken(t);
      })
      .catch(() => {
        /* artwork falls back to the unauthorised placeholder */
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
      .then((detail) => {
        if (alive) setState({ kind: 'ready', person: detail.person, items: detail.items });
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
              <p className="text-2xl font-semibold text-[#FF7B72]">Couldn’t load person</p>
              <p className="text-muted">{state.message}</p>
            </div>
          ) : null}
          {state.kind === 'ready' ? (
            <Filmography
              person={state.person}
              items={state.items}
              streamToken={streamToken}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface FilmographyProps {
  person: Person;
  items: Item[];
  streamToken?: string;
}

/** Person header + the focusable filmography grid. The first card autoFocuses
 *  so a remote press lands on a title immediately on entry. */
function Filmography({ person, items, streamToken }: FilmographyProps): JSX.Element {
  // Credit count = the number of titles returned (the filmography is the full
  // credited list), falling back to the server-reported count if items are
  // capped. Matches the reference VM (credits = items.size).
  const credits = items.length || person.credits || 0;

  return (
    <div className="flex flex-col gap-8">
      <PersonHeader name={person.name} credits={credits} />

      {items.length === 0 ? (
        <p className="text-muted">No titles for {person.name}.</p>
      ) : (
        <div className="flex flex-wrap gap-4 py-2">
          {items.map((item, i) => (
            <FocusableCard
              key={item.id}
              item={item}
              streamToken={streamToken}
              autoFocus={i === 0}
              onEnter={() => navigate(`/detail/${item.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Person header — initials-avatar + name + "· N titles" credit count. */
function PersonHeader({ name, credits }: { name: string; credits: number }): JSX.Element {
  const initials = initialsOf(name);
  return (
    <div className="flex items-center gap-6">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-surface text-2xl font-semibold text-text">
        {initials || <UserIcon className="h-8 w-8" />}
      </div>
      <div className="min-w-0">
        <h1 className="truncate text-4xl font-bold text-text">{name}</h1>
        <p className="mt-1 text-muted">· {creditLabel(credits)}</p>
      </div>
    </div>
  );
}

/** Up to two initials from a person's name, e.g. "Greta Gerwig" -> "GG". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]?.[0]?.toUpperCase() ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0]?.toUpperCase() ?? '' : '';
  return first + last;
}

/** "· N titles" copy, singularising at 1. Matches the Search people-row label. */
function creditLabel(credits: number): string {
  return credits === 1 ? '1 title' : `${credits} titles`;
}
