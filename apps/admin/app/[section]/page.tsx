import { AdminSectionPage } from "../../components/AdminSectionPage";

export default async function DynamicAdminSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return <AdminSectionPage section={section} />;
}
