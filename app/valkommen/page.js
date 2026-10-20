import { redirect } from 'next/navigation';
import Onboarding from '../../components/Onboarding.jsx';
import { aktivProfilId } from '../../src/auth.js';
import { inloggningsläge } from '../../src/authMode.js';
import { onboardingStatus } from '../../src/onboarding.js';

export const metadata = { title: 'JOBBFLO — välkommen' };
export const dynamic = 'force-dynamic';

export default async function Välkommen() {
  if (inloggningsläge() === 'av') redirect('/');
  return <Onboarding status={await onboardingStatus(await aktivProfilId())} />;
}
