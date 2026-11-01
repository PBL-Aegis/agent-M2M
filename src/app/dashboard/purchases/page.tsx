import { PurchaseTable } from "@/components/PurchaseTable";
import { listPurchases } from "@/lib/store";

export const dynamic = "force-dynamic";

// PBL-aegis 감사 대시보드의 "거래" 화면과 같은 구성.
export default async function PurchasesPage() {
  const records = await listPurchases();
  return (
    <>
      <div className="pageHead">
        <h1>전체 요청·결제 기록</h1>
      </div>
      <section className="panel">
        <PurchaseTable records={records} />
      </section>
    </>
  );
}
