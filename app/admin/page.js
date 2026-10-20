import { notFound } from 'next/navigation';
import AdminView from '../../components/AdminView.jsx';
import { adminProfilId } from '../../src/auth.js';

export const metadata = { title: 'JOBBFLO — admin' };
export const dynamic = 'force-dynamic';

// The operator's page. For anyone else it does not exist — the same
// 404 as any page that does not — so it does not announce itself.
export default async function AdminPage() {
  if (!(await adminProfilId())) notFound();
  return <AdminView />;
}
