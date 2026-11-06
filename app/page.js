import { redirect } from 'next/navigation';
import App from '../components/App.jsx';
import { BeaconProvider } from '../lib/beacon.jsx';
import { behöverOnboarding } from '../src/onboarding.js';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // A new account goes through the first-run guide once.
  if (await behöverOnboarding()) redirect('/valkommen');
  // One change beacon for every view on the page (lib/beacon.jsx).
  return <BeaconProvider><App /></BeaconProvider>;
}
