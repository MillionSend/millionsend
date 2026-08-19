import { SegmentDetail } from "./segment-detail";

export default async function SegmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SegmentDetail id={id} />;
}
