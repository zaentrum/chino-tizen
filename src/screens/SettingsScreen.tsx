// Settings — the rows surface for the Tizen TV client. Integrated into the same
// shell as every other non-player screen (SideRail with Settings active + the
// TopBar) rather than a standalone page, mirroring chino-androidtv's
// ui/settings/SettingsScreen.kt.
//
// Sections (top to bottom, matching androidtv):
//   - Binge watching: auto-skip intro/credits + auto-play-next toggles and a
//     countdown stepper. All read/write through settingsStore via useSettings().
//   - Audio / Subtitles: preferred-language pickers. Audio's sentinel is
//     "Original" (keep the source default → preferredAudioLang undefined);
//     subtitles' sentinel is "Off" (preferredSubtitleLang undefined). The
//     stored value is the ISO code; the sentinel maps to undefined so the
//     player treats "no preference" and "off/original" the same way the web
//     and androidtv clients do.
//   - Account: the active account name, Switch account (opens an in-screen
//     account-picker overlay), and Sign out.
//   - Server: the connected host + Change server (clears the saved server +
//     all accounts, then drops back to onboarding).
//   - Feedback: "Report a problem" → a canned-category picker overlay that
//     files through the shared bug reporter (no free text on TV).
//
// Every interactive element is a @/tv/focus focusable; BACK is wired through
// useRemoteKey (closing an open overlay first, else routing back). The whole
// page is one vertical scroll region so the focus engine's scrollIntoView keeps
// the focused row on screen as the user walks down it.

import { useEffect, useState } from 'react';
import { LogOut, Users, Server, Plus, Minus, MessageSquareWarning } from 'lucide-react';
import { SideRail } from '@/components/SideRail';
import { TopBar } from '@/components/TopBar';
import { useFocusable, useRemoteKey } from '@/tv/focus';
import { TVKey } from '@/tv/keys';
import { back, navigate } from '@/router';
import { useSettings } from '@/state/settings';
import { authStore, useAuth } from '@/auth/session';
import { serverConfigStore } from '@/state/serverConfig';
import {
  bugReporter,
  REPORT_CATEGORIES,
  describeReportError,
} from '@/feedback/bugReporter';
import type { FeedbackResult } from '@/api/types';

// Shared ISO-639-1 choices offered by both language pickers. The leading
// sentinel differs: subtitles offer "Off" (disable), audio offers "Original"
// (keep the source's default track). Mirrors androidtv LANG_CHOICES.
const LANG_CHOICES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'pt', name: 'Português' },
  { code: 'nl', name: 'Nederlands' },
];
// Sentinel code maps to `undefined` in the store (no preference). 'off' for
// subtitles, 'orig' for audio — the value never persists, it's just the
// selected pill when the stored preference is empty.
const SUB_LANGS = [{ code: 'off', name: 'Off' }, ...LANG_CHOICES];
const AUDIO_LANGS = [{ code: 'orig', name: 'Original' }, ...LANG_CHOICES];

export default function SettingsScreen(): JSX.Element {
  const { settings, set } = useSettings();
  const { account, accounts, signOut } = useAuth();

  // At most one overlay is open at a time. BACK closes the open overlay first,
  // then (when none is open) routes back to the previous screen.
  const [overlay, setOverlay] = useState<'report' | 'accounts' | null>(null);

  useRemoteKey(TVKey.BACK, () => {
    if (overlay) {
      setOverlay(null);
      return;
    }
    back();
  });

  // Connected-server host (no scheme/path) for the Server row subtitle.
  const host = serverConfigStore.get()?.apiBase
    ?.replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  // Change server: the saved server's OIDC issuer no longer matches the next
  // one, so the existing accounts' tokens are useless — clear both, then drop
  // back to onboarding (App.tsx renders Add-Server when no server is
  // configured). Mirrors androidtv's onChangeServer contract.
  const changeServer = (): void => {
    serverConfigStore.clear();
    for (const a of accounts) authStore.remove(a.sub);
    navigate('/');
  };

  return (
    <div className="flex min-h-screen bg-bg text-text">
      <SideRail active="settings" />
      <div className="flex min-h-screen flex-1 flex-col">
        <TopBar />
        <div className="flex-1 overflow-y-auto px-12 py-8">
          <h1 className="mb-8 text-4xl font-bold">Settings</h1>

          <div className="flex max-w-3xl flex-col gap-8">
            <Section
              title="Binge watching"
              subtitle="Skip recurring parts back-to-back without leaving the player. A short countdown gives you a chance to cancel before each skip fires."
            >
              <ToggleRow
                label="Auto-skip intros & recaps"
                help={'Skips the title sequence and any "Previously on…" recap at the top of an episode.'}
                value={settings.autoSkipIntro}
                onChange={(v) => set({ autoSkipIntro: v })}
              />
              <ToggleRow
                label="Auto-skip credits"
                help="Skips the closing credits at the end of an episode."
                value={settings.autoSkipCredits}
                onChange={(v) => set({ autoSkipCredits: v })}
              />
              <ToggleRow
                label="Auto-play next episode"
                help="Starts the next episode automatically when credits roll."
                value={settings.autoPlayNext}
                onChange={(v) => set({ autoPlayNext: v })}
              />
              <StepperRow
                label="Countdown before auto-skip"
                help="Seconds the countdown stays on screen before the player skips. Shorter feels snappier; longer gives more time to cancel."
                value={settings.skipCountdownSec}
                suffix="s"
                min={1}
                max={15}
                onChange={(v) => set({ skipCountdownSec: v })}
              />
            </Section>

            <Section
              title="Audio"
              subtitle="Default audio language. Picks the closest matching track on each item. Original keeps whatever the source marks as the default track."
            >
              <LangPickerRow
                options={AUDIO_LANGS}
                sentinel="orig"
                value={settings.preferredAudioLang}
                onChange={(code) => set({ preferredAudioLang: code })}
              />
            </Section>

            <Section
              title="Subtitles"
              subtitle="Default subtitle language. Picks the closest matching track on each item. Off keeps subtitles disabled by default."
            >
              <LangPickerRow
                options={SUB_LANGS}
                sentinel="off"
                value={settings.preferredSubtitleLang}
                onChange={(code) => set({ preferredSubtitleLang: code })}
              />
            </Section>

            <Section
              title="Account"
              subtitle="Sign in as a different user on this TV, or sign out of the current one."
            >
              <RowShell>
                <div className="flex flex-1 flex-col">
                  <span className="font-medium">{account?.name ?? 'Not signed in'}</span>
                  {account?.email ? (
                    <span className="text-base text-muted">{account.email}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <ActionButton
                    label="Switch account"
                    icon={<Users className="h-5 w-5" />}
                    onEnter={() => setOverlay('accounts')}
                  />
                  <ActionButton
                    label="Sign out"
                    icon={<LogOut className="h-5 w-5" />}
                    onEnter={signOut}
                  />
                </div>
              </RowShell>
            </Section>

            <Section
              title="Server"
              subtitle={host ? `Connected to ${host}.` : 'Connect to a different Chino server.'}
            >
              <RowShell>
                <span className="flex-1 text-muted">
                  Connecting to a different server signs out the accounts on this one.
                </span>
                <ActionButton
                  label="Change server"
                  icon={<Server className="h-5 w-5" />}
                  onEnter={changeServer}
                />
              </RowShell>
            </Section>

            <Section
              title="Feedback"
              subtitle="Something not working? File a bug straight to the dev backlog — no typing needed, device and app details ride along automatically."
            >
              <RowShell>
                <span className="flex-1 text-muted">
                  Pick the closest match to what's going wrong.
                </span>
                <ActionButton
                  label="Report a problem"
                  icon={<MessageSquareWarning className="h-5 w-5" />}
                  onEnter={() => setOverlay('report')}
                />
              </RowShell>
            </Section>
          </div>
        </div>
      </div>

      {overlay === 'report' ? (
        <ReportProblemDialog onClose={() => setOverlay(null)} />
      ) : null}
      {overlay === 'accounts' ? (
        <SwitchAccountDialog onClose={() => setOverlay(null)} />
      ) : null}
    </div>
  );
}

/* ─────────────────────────────  Layout pieces  ──────────────────────────── */

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="text-base text-muted">{subtitle}</p>
      <div className="flex flex-col rounded-xl bg-surface py-2">{children}</div>
    </section>
  );
}

/** The common row chrome — a flex row with the label block on the left and the
 *  control(s) on the right. */
function RowShell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-6 px-5 py-4">{children}</div>
  );
}

/* ───────────────────────────────  Controls  ─────────────────────────────── */

/** A focusable pill button used across the rows (Switch account, Change
 *  server, Report a problem, …). Focus ring via data-focused; the focused fill
 *  matches the shell's secondary-button treatment. */
function ActionButton({
  label,
  icon,
  onEnter,
  autoFocus,
}: {
  label: string;
  icon?: React.ReactNode;
  onEnter: () => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`inline-flex cursor-default select-none items-center gap-2 rounded-lg px-5 py-2.5 text-lg font-medium transition-colors ${
        focused ? 'bg-accent text-bg' : 'bg-surface-2 text-text'
      }`}
    >
      {icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
      {label}
    </div>
  );
}

/** Two-state ON/OFF toggle. ENTER flips the value in place. */
function ToggleRow({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter: () => onChange(!value) });
  return (
    <div className="flex items-center gap-6 px-5 py-4">
      <div className="flex flex-1 flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-base text-muted">{help}</span>
      </div>
      <div
        ref={ref}
        data-focused={focused}
        className={`inline-flex w-20 cursor-default select-none items-center justify-center rounded-lg px-4 py-2.5 text-lg font-semibold transition-colors ${
          value ? 'bg-accent text-bg' : 'bg-surface-2 text-text'
        } ${focused ? 'ring-2 ring-accent' : ''}`}
      >
        {value ? 'ON' : 'OFF'}
      </div>
    </div>
  );
}

/** A − / value / + stepper, clamped to [min,max]. Each of the −/+ chips is its
 *  own focusable so LEFT/RIGHT walks across them and ENTER nudges the value. */
function StepperRow({
  label,
  help,
  value,
  suffix,
  min,
  max,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}): JSX.Element {
  const dec = useFocusable({ onEnter: () => onChange(Math.max(min, value - 1)) });
  const inc = useFocusable({ onEnter: () => onChange(Math.min(max, value + 1)) });
  return (
    <div className="flex items-center gap-6 px-5 py-4">
      <div className="flex flex-1 flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-base text-muted">{help}</span>
      </div>
      <div className="flex items-center gap-3">
        <StepChip refFn={dec.ref} focused={dec.focused} disabled={value <= min}>
          <Minus className="h-5 w-5" />
        </StepChip>
        <div className="w-20 rounded-lg border border-border-2 bg-surface-2 py-2 text-center text-lg font-semibold">
          {value}
          {suffix}
        </div>
        <StepChip refFn={inc.ref} focused={inc.focused} disabled={value >= max}>
          <Plus className="h-5 w-5" />
        </StepChip>
      </div>
    </div>
  );
}

function StepChip({
  refFn,
  focused,
  disabled,
  children,
}: {
  refFn: (el: HTMLElement | null) => void;
  focused: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      ref={refFn}
      data-focused={focused}
      className={`flex h-11 w-11 cursor-default select-none items-center justify-center rounded-lg transition-colors ${
        focused ? 'bg-accent text-bg' : 'bg-surface-2 text-text'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      {children}
    </div>
  );
}

/** A horizontal row of language pills. The selected pill is the stored code, or
 *  the sentinel when no preference is stored. Selecting the sentinel clears the
 *  preference (stores undefined); selecting any real code stores it. */
function LangPickerRow({
  options,
  sentinel,
  value,
  onChange,
}: {
  options: { code: string; name: string }[];
  sentinel: string;
  value: string | undefined;
  onChange: (code: string | undefined) => void;
}): JSX.Element {
  const selected = value ?? sentinel;
  return (
    <div className="flex flex-wrap gap-3 px-5 py-4">
      {options.map((opt) => {
        const on = selected === opt.code;
        return (
          <LangPill
            key={opt.code}
            label={opt.name}
            selected={on}
            onEnter={() => onChange(opt.code === sentinel ? undefined : opt.code)}
          />
        );
      })}
    </div>
  );
}

function LangPill({
  label,
  selected,
  onEnter,
}: {
  label: string;
  selected: boolean;
  onEnter: () => void;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter });
  return (
    <div
      ref={ref}
      data-focused={focused}
      className={`cursor-default select-none rounded-lg px-4 py-2 text-lg transition-colors ${
        selected ? 'bg-accent text-bg' : 'bg-surface-2 text-text'
      } ${focused ? 'ring-2 ring-accent' : ''}`}
    >
      {label}
    </div>
  );
}

/* ─────────────────────────────  Overlays  ───────────────────────────────── */

/** Generic scrim + #161B22 card shell for the two Settings overlays (the
 *  player MenuPopover idiom). The first focusable inside gets autoFocus; BACK
 *  is handled by the parent (which closes the open overlay first). */
function DialogCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex w-[34rem] flex-col gap-1 rounded-2xl border border-border-2 bg-surface py-4">
        {children}
      </div>
    </div>
  );
}

/** One focusable row inside a dialog card — ENTER selects, blue focus tint.
 *  Structural clone of the player menu rows so the picker inherits the same
 *  D-pad model as every other panel. */
function DialogRow({
  label,
  sublabel,
  onEnter,
  autoFocus,
  disabled,
}: {
  label: string;
  sublabel?: string;
  onEnter: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const { ref, focused } = useFocusable({ onEnter, autoFocus, disabled });
  return (
    <div
      ref={ref}
      data-focused={focused}
      aria-disabled={disabled}
      className={`mx-2 flex cursor-default select-none flex-col rounded-lg px-5 py-3 transition-colors ${
        focused ? 'bg-accent/20' : ''
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <span className="text-lg text-text">{label}</span>
      {sublabel ? <span className="text-base text-muted">{sublabel}</span> : null}
    </div>
  );
}

/**
 * Manual bug-report picker. OK on a category files the report through
 * bugReporter.reportManual; on success the card swaps to a "Filed bug #id" /
 * "Added to existing bug #id" confirmation (Close auto-focuses), on failure it
 * shows an inline plain-language line above the rows so the user can retry.
 * Mirrors androidtv's ReportProblemDialog.
 */
type ReportStatus =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'filed'; result: FeedbackResult }
  | { phase: 'failed'; message: string };

function ReportProblemDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<ReportStatus>({ phase: 'idle' });

  const file = (category: string): void => {
    if (status.phase === 'sending') return; // swallow repeats while in flight
    setStatus({ phase: 'sending' });
    bugReporter
      .reportManual({ category })
      .then((result) => setStatus({ phase: 'filed', result }))
      .catch((err) => setStatus({ phase: 'failed', message: describeReportError(err) }));
  };

  if (status.phase === 'filed') {
    const { result } = status;
    return (
      <DialogCard>
        <p className="px-5 pb-1 text-lg font-semibold text-text">
          {result.duplicate ? `Added to existing bug #${result.id}` : `Filed bug #${result.id}`}
        </p>
        <p className="px-5 pb-2 text-base text-muted">
          Thanks — the report landed on the dev backlog.
        </p>
        <DialogRow label="Close" onEnter={onClose} autoFocus />
      </DialogCard>
    );
  }

  return (
    <DialogCard>
      <p className="px-5 pb-1 text-base font-medium uppercase tracking-wide text-muted">
        Report a problem
      </p>
      <p
        className={`px-5 pb-2 text-base ${
          status.phase === 'failed' ? 'text-red' : 'text-muted'
        }`}
      >
        {status.phase === 'failed'
          ? status.message
          : status.phase === 'sending'
            ? 'Sending the report…'
            : "What's going wrong? Pick the closest match."}
      </p>
      {REPORT_CATEGORIES.map((category, i) => (
        <DialogRow
          key={category}
          label={category}
          autoFocus={i === 0}
          disabled={status.phase === 'sending'}
          onEnter={() => file(category)}
        />
      ))}
    </DialogCard>
  );
}

/**
 * Switch-account picker. Lists the signed-in accounts (ENTER makes one active
 * and closes) plus an "Add account" row that re-runs onboarding's Add-Server /
 * device-flow on the same server. Mirrors the account-switch affordance the
 * androidtv Settings exposes via onSwitchAccount.
 */
function SwitchAccountDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { accounts, account } = useAuth();
  return (
    <DialogCard>
      <p className="px-5 pb-2 text-base font-medium uppercase tracking-wide text-muted">
        Switch account
      </p>
      {accounts.map((a, i) => (
        <DialogRow
          key={a.sub}
          label={a.name + (a.sub === account?.sub ? '  ·  current' : '')}
          sublabel={a.email}
          autoFocus={i === 0}
          onEnter={() => {
            authStore.setActive(a.sub);
            onClose();
          }}
        />
      ))}
      <DialogRow
        label="Add account"
        autoFocus={accounts.length === 0}
        onEnter={() => {
          // Re-run the sign-in flow on the same server. App.tsx renders the
          // device-flow / account onboarding when prompted; navigating home
          // with no active session change is the safe default — the integrator
          // routes unauthed/add-account intents from there.
          navigate('/');
        }}
      />
    </DialogCard>
  );
}

/* ───────────────────────────  Crash-drain bootstrap  ─────────────────────── */

/**
 * Hook the global crash drain (window error / unhandledrejection → persisted +
 * best-effort live report) and flush any reports a previous process left
 * behind. Installs once; flushPending runs once per process. Safe to call from
 * any mounted screen — the Settings screen does it on mount so the drain is
 * live by the time the user can reach the manual reporter, but the integrator
 * may also call it earlier from the app root.
 */
export function useCrashDrain(): void {
  useEffect(() => {
    bugReporter.install();
    void bugReporter.flushPending();
  }, []);
}
