"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authedFetch } from "@/lib/authedFetch";
import { auth } from "@/lib/firebase";
import { INDUSTRY_OPTIONS } from "@/lib/industries";
import { parseTenantInput, type InputErrors } from "@/lib/provisioning/input";
import {
  STEP_IDS,
  STEP_LABELS,
  type Conflict,
  type ProvisioningView,
  type StepStatus,
} from "@/lib/provisioning/types";

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "未実行",
  running: "実行中",
  waiting: "待機中",
  done: "完了",
  skipped: "省略",
  failed: "失敗",
};

const STATUS_CLASS: Record<StepStatus, string> = {
  pending: "text-gray-500",
  running: "text-blue-700",
  waiting: "text-amber-700",
  done: "text-emerald-700",
  skipped: "text-gray-500",
  failed: "text-red-700",
};

const RUN_LABEL: Record<ProvisioningView["status"], string> = {
  in_progress: "途中",
  waiting: "待機中",
  failed: "失敗で停止",
  completed: "完了",
};

const API = "/api/admin/tenants";
const BUSY_RETRY_MS = 5_000;
const fieldClass =
  "w-full h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400";

async function apiMessage(response: Response) {
  if (response.status === 401) return "ログインし直してください。";
  if (response.status === 403) return "管理者のみ操作できます。";
  return `処理できませんでした（${response.status}）。`;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-sm text-red-700">{message}</p> : null;
}

function TenantForm({ onStarted }: { onStarted: (run: ProvisioningView) => void }) {
  const [siteName, setSiteName] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [domain, setDomain] = useState("");
  const [wwwEnabled, setWwwEnabled] = useState(true);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [industryKey, setIndustryKey] = useState("");
  const [industryOther, setIndustryOther] = useState("");
  const [plan, setPlan] = useState<"paid" | "free">("paid");
  const [errors, setErrors] = useState<InputErrors>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const raw = { siteName, siteKey, domain, wwwEnabled, ownerEmail, industryKey, industryOther, plan };
    const parsed = parseTenantInput(raw);
    setConflicts([]);
    setMessage("");
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});

    const billing = plan === "paid" ? "有料（オーナーの支払い後に公開します）" : "無料";
    const confirmed = window.confirm(
      `この内容で店舗を追加します。\n\n店名: ${parsed.input.siteName}\n店舗キー: ${parsed.input.siteKey}\nドメイン: ${parsed.input.domain}${wwwEnabled ? `（www も追加）` : ""}\nオーナー: ${parsed.input.ownerEmail}\nプラン: ${billing}`
    );
    if (!confirmed) return;

    setSubmitting(true);
    try {
      const response = await authedFetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(raw),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 201) {
        onStarted(data.run);
      } else if (response.status === 409) {
        setConflicts(data.conflicts ?? []);
      } else if (response.status === 400) {
        setErrors(data.errors ?? {});
      } else if (data?.problems?.length) {
        setMessage(`開始できません: ${data.problems.join(" / ")}`);
      } else {
        setMessage(await apiMessage(response));
      }
    } catch {
      setMessage("通信に失敗しました。もう一度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>新規店舗の追加</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-1 text-sm font-medium">
          店名
          <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
          <FieldError message={errors.siteName} />
        </label>
        <label className="block space-y-1 text-sm font-medium">
          店舗キー
          <Input
            value={siteKey}
            placeholder="例: sakura-bakery"
            onChange={(e) => setSiteKey(e.target.value)}
          />
          <span className="block text-xs font-normal text-gray-600">
            Vercelのプロジェクト名は pageit-{siteKey.trim() || "店舗キー"} になります。後から変更できません。
          </span>
          <FieldError message={errors.siteKey} />
        </label>
        <label className="block space-y-1 text-sm font-medium">
          ドメイン（wwwなし）
          <Input
            value={domain}
            placeholder="例: example.com"
            onChange={(e) => setDomain(e.target.value)}
          />
          <FieldError message={errors.domain} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={wwwEnabled}
            onChange={(e) => setWwwEnabled(e.target.checked)}
          />
          www も追加する（www なしへ転送します）
        </label>
        <label className="block space-y-1 text-sm font-medium">
          オーナーのメールアドレス
          <Input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
          />
          <FieldError message={errors.ownerEmail} />
        </label>
        <label className="block space-y-1 text-sm font-medium">
          業種
          <select
            className={fieldClass}
            value={industryKey}
            onChange={(e) => setIndustryKey(e.target.value)}
          >
            <option value="" disabled>
              選択してください
            </option>
            {INDUSTRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <FieldError message={errors.industry} />
        </label>
        {industryKey === "other" && (
          <label className="block space-y-1 text-sm font-medium">
            その他の業種
            <Input value={industryOther} onChange={(e) => setIndustryOther(e.target.value)} />
            <FieldError message={errors.industryOther} />
          </label>
        )}
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">プラン</legend>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" checked={plan === "paid"} onChange={() => setPlan("paid")} />
            有料
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={plan === "free"} onChange={() => setPlan("free")} />
            無料
          </label>
        </fieldset>

        {conflicts.length > 0 && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
            <p className="font-medium">使用済みのため、何も作成していません。</p>
            <ul className="mt-1 list-disc pl-5">
              {conflicts.map((item) => (
                <li key={item.message}>{item.message}</li>
              ))}
            </ul>
          </div>
        )}
        {message && (
          <p className="text-sm text-red-700" role="alert">
            {message}
          </p>
        )}
        <Button className="w-full" disabled={submitting} onClick={submit}>
          {submitting ? "確認中..." : "追加を開始する"}
        </Button>
      </CardContent>
    </Card>
  );
}

function DnsPanel({ run }: { run: ProvisioningView }) {
  const dns = run.resources.dns;
  if (!dns) return null;
  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3 text-sm">
      <p className="font-medium">ドメイン業者で設定するDNSの値</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-xs">
          <thead>
            <tr className="text-gray-600">
              <th className="py-1 pr-3 font-medium">ドメイン</th>
              <th className="py-1 pr-3 font-medium">種類</th>
              <th className="py-1 pr-3 font-medium">名前</th>
              <th className="py-1 pr-3 font-medium">値</th>
              <th className="py-1 font-medium">状態</th>
            </tr>
          </thead>
          <tbody>
            {dns.hosts.flatMap((host) =>
              host.records.map((record) => (
                <tr key={`${host.host}-${record.type}-${record.value}`} className="border-t border-gray-100">
                  <td className="py-1 pr-3">{host.host}</td>
                  <td className="py-1 pr-3 font-mono">{record.type}</td>
                  <td className="py-1 pr-3 font-mono">{record.name}</td>
                  <td className="py-1 pr-3 font-mono break-all">{record.value}</td>
                  <td className={`py-1 whitespace-nowrap ${host.verified && !host.misconfigured ? "text-emerald-700" : "text-amber-700"}`}>
                    {host.verified && !host.misconfigured ? "反映済み" : "未反映"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-600">
        最終確認: {new Date(dns.checkedAt).toLocaleString("ja-JP")}。DNSの反映には時間がかかることがあります。
      </p>
    </div>
  );
}

function RunPanel({
  run,
  working,
  notice,
  onAction,
  onDiscard,
  onClose,
}: {
  run: ProvisioningView;
  working: boolean;
  notice: string;
  onAction: (options: { resume?: boolean; resendMail?: boolean }) => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const dnsWaiting = run.steps.dns.status === "waiting";
  const canResume = run.status === "failed" || (run.status !== "completed" && !dnsWaiting);
  const { deployment } = run.resources;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {run.input.siteName}（{run.siteKey}）: {RUN_LABEL[run.status]}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2">
          {STEP_IDS.map((id, index) => {
            const step = run.steps[id];
            return (
              <li key={id} className="text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    {index + 1}. {STEP_LABELS[id]}
                  </span>
                  <span className={`shrink-0 font-medium ${STATUS_CLASS[step.status]}`}>
                    {STATUS_LABEL[step.status]}
                  </span>
                </div>
                {step.error && (
                  <p className="mt-1 rounded-md bg-red-50 p-2 text-red-800 break-words" role="alert">
                    {step.error.message}
                  </p>
                )}
                {id === "deployment" && deployment && step.status === "waiting" && (
                  <p className="mt-1 text-xs text-gray-600">Vercelの状態: {deployment.state}</p>
                )}
              </li>
            );
          })}
        </ol>

        <DnsPanel run={run} />

        {notice && (
          <p className="text-sm text-gray-700" role="status">
            {notice}
          </p>
        )}

        {run.status === "completed" && (
          <p className="text-sm text-emerald-800">
            {run.input.plan === "paid"
              ? "案内メールを送信しました。オーナーの支払いが済むと公開されます"
              : "公開と案内メールの送信が完了しました"}
            : https://{run.input.domain}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {canResume && (
            <Button disabled={working} onClick={() => onAction({ resume: true })}>
              {working ? "実行中..." : "再開"}
            </Button>
          )}
          {dnsWaiting && (
            <Button disabled={working} onClick={() => onAction({})}>
              {working ? "確認中..." : "DNSの反映を再確認"}
            </Button>
          )}
          {run.canResendMail && (
            <Button
              variant="outline"
              disabled={working}
              onClick={() => {
                if (window.confirm(`${run.input.ownerEmail} に案内メールを送り直します。`)) {
                  onAction({ resendMail: true });
                }
              }}
            >
              案内メールを再送
            </Button>
          )}
          {run.discardable && (
            <Button variant="outline" disabled={working} onClick={onDiscard}>
              記録を破棄
            </Button>
          )}
          <Button variant="outline" disabled={working} onClick={onClose}>
            閉じる
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TenantsNewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const siteKeyParam = searchParams.get("siteKey");

  const [ready, setReady] = useState(false);
  const [run, setRun] = useState<ProvisioningView | null>(null);
  const [unfinished, setUnfinished] = useState<ProvisioningView[]>([]);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [pageError, setPageError] = useState("");
  const loopId = useRef(0);

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      if (user) setReady(true);
      else router.push("/login");
    });
  }, [router]);

  const loadUnfinished = useCallback(async () => {
    const response = await authedFetch(API);
    if (response.ok) setUnfinished((await response.json()).runs);
    else setPageError(await apiMessage(response));
  }, []);

  useEffect(() => {
    if (!ready) return;
    loadUnfinished().catch(() => setPageError("進行中の一覧を読み込めませんでした。"));
  }, [ready, loadUnfinished]);

  useEffect(() => {
    if (!ready || !siteKeyParam) {
      if (!siteKeyParam) setRun(null);
      return;
    }
    (async () => {
      const response = await authedFetch(`${API}/${encodeURIComponent(siteKeyParam)}`);
      if (response.ok) setRun((await response.json()).run);
      else setPageError(await apiMessage(response));
    })().catch(() => setPageError("進行状況を読み込めませんでした。"));
  }, [ready, siteKeyParam]);

  // 画面を離れたら自動の繰り返しを止めます（処理の続きは「再開」で行えます）
  useEffect(() => () => {
    loopId.current += 1;
  }, []);

  /** 次の手順がある間、APIを繰り返し呼びます。1回で1手順だけ進みます。 */
  const drive = useCallback(
    async (siteKey: string, first: { resume?: boolean; resendMail?: boolean }) => {
      const id = ++loopId.current;
      setWorking(true);
      setNotice("");
      let options = first;
      try {
        while (loopId.current === id) {
          const response = await authedFetch(`${API}/${encodeURIComponent(siteKey)}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options),
          });
          options = {};
          if (!response.ok) {
            setNotice(await apiMessage(response));
            return;
          }
          const current = (await response.json()).run as ProvisioningView;
          setRun(current);

          if (current.busy) {
            setNotice("別の画面で実行中です。少し待って確認します。");
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
            continue;
          }
          setNotice("");
          if (current.status === "in_progress") continue;
          if (current.status === "waiting" && current.retryAfterMs) {
            await new Promise((resolve) => setTimeout(resolve, current.retryAfterMs ?? 0));
            continue;
          }
          return;
        }
      } catch {
        setNotice("通信に失敗しました。「再開」を押すと続きから実行します。");
      } finally {
        if (loopId.current === id) {
          setWorking(false);
          loadUnfinished().catch(() => undefined);
        }
      }
    },
    [loadUnfinished]
  );

  const open = (siteKey: string) => router.replace(`/tenants/new?siteKey=${encodeURIComponent(siteKey)}`);

  const close = () => {
    loopId.current += 1;
    setWorking(false);
    setRun(null);
    setNotice("");
    router.replace("/tenants/new");
    loadUnfinished().catch(() => undefined);
  };

  const discard = async () => {
    if (!run || !window.confirm(`店舗キー「${run.siteKey}」の記録を破棄します。`)) return;
    const response = await authedFetch(`${API}/${encodeURIComponent(run.siteKey)}`, { method: "DELETE" });
    if (response.ok) close();
    else setNotice("破棄できませんでした。すでに手順が進んでいる可能性があります。");
  };

  if (!ready) return null;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-4 sm:p-8">
      {pageError && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
          {pageError}
        </p>
      )}

      {run ? (
        <RunPanel
          run={run}
          working={working}
          notice={notice}
          onAction={(options) => drive(run.siteKey, options)}
          onDiscard={discard}
          onClose={close}
        />
      ) : (
        <>
          <TenantForm
            onStarted={(started) => {
              setRun(started);
              open(started.siteKey);
              drive(started.siteKey, {});
            }}
          />
          {unfinished.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">途中の店舗追加</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-gray-100">
                  {unfinished.map((item) => (
                    <li key={item.siteKey} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 break-words">
                        {item.input.siteName}（{item.siteKey}）: {RUN_LABEL[item.status]}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => open(item.siteKey)}>
                        開く
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export default function TenantsNewPage() {
  return (
    <Suspense fallback={null}>
      <TenantsNewContent />
    </Suspense>
  );
}
