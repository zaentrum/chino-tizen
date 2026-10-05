// App root + boot gate. The onboarding screens (AddServer, DeviceCode) each
// navigate('/') after their step and rely on THIS gate to decide what comes
// next, so the gate reads serverConfig + auth state fresh on every render and
// re-renders on navigation (useRoute subscribes to popstate):
//
//   no server configured        -> AddServerScreen   (sets config, navigate('/'))
//   server set, not signed in    -> DeviceCodeScreen  (device flow, navigate('/'))
//   signed in                    -> MainApp (route switch + per-screen shell)
//
// FocusProvider installs the single global D-pad keydown handler; AuthProvider
// runs the background token-refresh timer.

import { FocusProvider } from './tv/focus';
import { AuthProvider, useAuth } from './auth/session';
import { serverConfigStore } from './state/serverConfig';
import { useNoticesPolling } from './state/notices';
import { useRoute, matchRoute } from './router';
import Spinner from './components/Spinner';

import AddServerScreen from './screens/onboarding/AddServerScreen';
import DeviceCodeScreen from './screens/onboarding/DeviceCodeScreen';

import HomeScreen from './screens/HomeScreen';
import BrowseScreen from './screens/BrowseScreen';
import DetailScreen from './screens/DetailScreen';
import SearchScreen from './screens/SearchScreen';
import PersonScreen from './screens/PersonScreen';
import WatchlistScreen from './screens/WatchlistScreen';
import SettingsScreen, { useCrashDrain } from './screens/SettingsScreen';
import DeleteAccountScreen from './screens/DeleteAccountScreen';
import NoticesScreen from './screens/NoticesScreen';
import ZapScreen from './screens/ZapScreen';
import PlayerScreen from './screens/PlayerScreen';
import TrailerScreen from './screens/TrailerScreen';

/** Picks the screen for the current route. Detail and Trailer take their ids
 *  as props; the other id/param screens read useRoute() themselves. */
function MainApp(): JSX.Element {
  const { path } = useRoute();
  const { name, params } = matchRoute(path);
  // What addons told the signed-in person, kept current while they are
  // signed in — this tree is mounted only then — for the top bar's bell.
  const { account } = useAuth();
  useNoticesPolling(account?.sub ?? null);
  switch (name) {
    case 'browse':
      return <BrowseScreen />;
    case 'detail':
      return <DetailScreen id={params.id} />;
    case 'search':
      return <SearchScreen />;
    case 'person':
      return <PersonScreen />;
    case 'watchlist':
      return <WatchlistScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'deleteAccount':
      return <DeleteAccountScreen />;
    case 'notices':
      return <NoticesScreen />;
    case 'zap':
      return <ZapScreen />;
    case 'player':
      // Keyed by the item: the next episode (auto-play, "Next episode") is a
      // fresh player, not the last one's refs — its resume position, watched
      // and auto-advance guards would otherwise carry over to the new title.
      return <PlayerScreen key={params.id} />;
    case 'trailer':
      // A trailer of its own engine and nothing else of the player: no
      // progress, no watched state (@/screens/TrailerScreen).
      return (
        <TrailerScreen
          key={`${params.itemId}/${params.extraId}`}
          itemId={params.itemId}
          extraId={params.extraId}
        />
      );
    case 'home':
    default:
      return <HomeScreen />;
  }
}

/** The boot gate — reactive to route changes (via useRoute) and auth state. */
function Root(): JSX.Element {
  useRoute(); // re-render the gate whenever navigate()/back() changes the path
  const auth = useAuth();
  useCrashDrain(); // install crash drain + flush pending reports once, at root

  const hasServer = serverConfigStore.get() != null;
  if (!hasServer) return <AddServerScreen />;
  if (auth.status === 'loading') return <Spinner fullscreen label="Starting…" />;
  if (auth.status === 'unauthed') return <DeviceCodeScreen />;
  return <MainApp />;
}

export default function App(): JSX.Element {
  return (
    <FocusProvider>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </FocusProvider>
  );
}
