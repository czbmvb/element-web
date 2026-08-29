/*
GSPCOMS: pestaña "WhatsApp" en Ajustes — conectar el WhatsApp del usuario al chat vía el
puente mautrix-whatsapp (API de aprovisionamiento en <homeserver>/_matrix/provision/v3).
*/

import React, { type JSX, useCallback, useEffect, useRef, useState } from "react";

import AccessibleButton from "../../../elements/AccessibleButton";
import QRCode from "../../../elements/QRCode";
import Spinner from "../../../elements/Spinner";
import { _t } from "../../../../../languageHandler";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection, SettingsSubsectionText } from "../../shared/SettingsSubsection";
import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";

interface WhatsAppLogin {
    id: string;
    name: string;
    connected: boolean;
}

type LinkState =
    | { kind: "idle" }
    | { kind: "starting" }
    | { kind: "qr"; loginId: string; qrData: string }
    | { kind: "code"; loginId: string; code: string }
    | { kind: "success" }
    | { kind: "error"; message: string };

interface Step {
    loginId: string;
    stepId: string;
    type: string;
    dwType?: string;
    data?: string;
}

function parseStep(obj: any): Step {
    const dw = obj?.display_and_wait ?? {};
    return {
        loginId: obj?.login_id ?? "",
        stepId: obj?.step_id ?? "",
        type: obj?.type ?? "",
        dwType: dw.type,
        data: dw.data,
    };
}

const WhatsAppUserSettingsTab: React.FC = (): JSX.Element => {
    const client = useMatrixClientContext();
    const [logins, setLogins] = useState<WhatsAppLogin[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [link, setLink] = useState<LinkState>({ kind: "idle" });
    const [busy, setBusy] = useState(false);
    const linkRun = useRef(0); // para ignorar respuestas de un intento cancelado

    const api = useCallback(
        async (path: string, method: "GET" | "POST" = "GET", longPoll = false): Promise<any> => {
            const base = client.getHomeserverUrl().replace(/\/+$/, "");
            const url = new URL(`${base}/_matrix/provision/v3/${path}`);
            url.searchParams.set("user_id", client.getSafeUserId());
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), longPoll ? 150_000 : 30_000);
            try {
                const res = await fetch(url.toString(), {
                    method,
                    headers: {
                        Authorization: `Bearer ${client.getAccessToken() ?? ""}`,
                        "Content-Type": "application/json",
                    },
                    body: method === "POST" ? "{}" : undefined,
                    signal: controller.signal,
                });
                const text = await res.text();
                let obj: any = {};
                try {
                    obj = JSON.parse(text);
                } catch {
                    obj = {};
                }
                if (!res.ok) {
                    throw new Error(obj?.error || `HTTP ${res.status}`);
                }
                return obj;
            } finally {
                clearTimeout(timer);
            }
        },
        [client],
    );

    const load = useCallback(async (): Promise<void> => {
        setLoadError(null);
        try {
            const obj = await api("whoami");
            const list: WhatsAppLogin[] = (obj?.logins ?? []).map((l: any) => ({
                id: l.id ?? "",
                name: l.name || l.profile?.phone || l.id || "WhatsApp",
                connected: !l.state?.state_event || l.state.state_event === "CONNECTED",
            }));
            setLogins(list);
        } catch (e: any) {
            setLogins([]);
            setLoadError(e?.message ?? String(e));
        }
    }, [api]);

    useEffect(() => {
        void load();
    }, [load]);

    const startLink = useCallback(async (): Promise<void> => {
        const run = ++linkRun.current;
        setLink({ kind: "starting" });
        try {
            let step = parseStep(await api("login/start/qr", "POST"));
            // Bucle: mostrar QR/código y esperar; el puente renueva el QR cuando caduca.
            for (;;) {
                if (run !== linkRun.current) return;
                if (step.type === "complete") {
                    setLink({ kind: "success" });
                    await load();
                    return;
                }
                if (step.type !== "display_and_wait") {
                    throw new Error(_t("gspcoms_whatsapp|unsupported_step", { type: step.type }));
                }
                if (step.dwType === "qr") {
                    setLink({ kind: "qr", loginId: step.loginId, qrData: step.data ?? "" });
                } else if (step.dwType === "code") {
                    setLink({ kind: "code", loginId: step.loginId, code: step.data ?? "" });
                } else {
                    throw new Error(_t("gspcoms_whatsapp|unsupported_step", { type: step.dwType ?? "" }));
                }
                step = parseStep(await api(`login/step/${step.loginId}/${step.stepId}/display_and_wait`, "POST", true));
            }
        } catch (e: any) {
            if (run !== linkRun.current) return;
            setLink({ kind: "error", message: e?.name === "AbortError" ? _t("gspcoms_whatsapp|timeout") : (e?.message ?? String(e)) });
        }
    }, [api, load]);

    const cancelLink = useCallback((): void => {
        const current = link;
        linkRun.current++;
        setLink({ kind: "idle" });
        if (current.kind === "qr" || current.kind === "code") {
            void api(`login/cancel/${current.loginId}`, "POST").catch(() => undefined);
        }
    }, [api, link]);

    const disconnect = useCallback(
        async (loginId: string): Promise<void> => {
            setBusy(true);
            try {
                await api(`logout/${loginId}`, "POST");
            } catch (e: any) {
                setLink({ kind: "error", message: e?.message ?? String(e) });
            } finally {
                setBusy(false);
                await load();
            }
        },
        [api, load],
    );

    let body: JSX.Element;
    switch (link.kind) {
        case "starting":
            body = (
                <SettingsSubsectionText>
                    <Spinner /> {_t("gspcoms_whatsapp|starting")}
                </SettingsSubsectionText>
            );
            break;
        case "qr":
            body = (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
                    <SettingsSubsectionText>{_t("gspcoms_whatsapp|scan_hint")}</SettingsSubsectionText>
                    <QRCode data={link.qrData} width={220} />
                    <SettingsSubsectionText>{_t("gspcoms_whatsapp|waiting")}</SettingsSubsectionText>
                    <AccessibleButton kind="primary_outline" onClick={cancelLink}>
                        {_t("action|cancel")}
                    </AccessibleButton>
                </div>
            );
            break;
        case "code":
            body = (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
                    <SettingsSubsectionText>{_t("gspcoms_whatsapp|code_hint")}</SettingsSubsectionText>
                    <div style={{ fontSize: "28px", fontWeight: 700, letterSpacing: "4px" }}>{link.code}</div>
                    <AccessibleButton kind="primary_outline" onClick={cancelLink}>
                        {_t("action|cancel")}
                    </AccessibleButton>
                </div>
            );
            break;
        case "success":
            body = (
                <div>
                    <SettingsSubsectionText>{_t("gspcoms_whatsapp|success")}</SettingsSubsectionText>
                    <AccessibleButton kind="primary" onClick={() => setLink({ kind: "idle" })}>
                        {_t("action|done")}
                    </AccessibleButton>
                </div>
            );
            break;
        case "error":
            body = (
                <div>
                    <SettingsSubsectionText>{_t("gspcoms_whatsapp|error", { message: link.message })}</SettingsSubsectionText>
                    <AccessibleButton kind="primary" onClick={() => void startLink()}>
                        {_t("action|retry")}
                    </AccessibleButton>{" "}
                    <AccessibleButton kind="primary_outline" onClick={() => setLink({ kind: "idle" })}>
                        {_t("action|cancel")}
                    </AccessibleButton>
                </div>
            );
            break;
        default:
            body = (
                <div>
                    {logins === null && !loadError && <Spinner />}
                    {loadError && (
                        <SettingsSubsectionText>
                            {_t("gspcoms_whatsapp|error", { message: loadError })}{" "}
                            <AccessibleButton kind="link" onClick={() => void load()}>
                                {_t("action|retry")}
                            </AccessibleButton>
                        </SettingsSubsectionText>
                    )}
                    {logins !== null && logins.length === 0 && !loadError && (
                        <SettingsSubsectionText>{_t("gspcoms_whatsapp|none")}</SettingsSubsectionText>
                    )}
                    {logins?.map((l) => (
                        <div
                            key={l.id}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0" }}
                        >
                            <span>
                                <strong>{l.name}</strong>{" "}
                                <span style={{ opacity: 0.7 }}>
                                    {l.connected ? _t("gspcoms_whatsapp|state_connected") : _t("gspcoms_whatsapp|state_disconnected")}
                                </span>
                            </span>
                            <AccessibleButton kind="danger_outline" disabled={busy} onClick={() => void disconnect(l.id)}>
                                {_t("gspcoms_whatsapp|disconnect")}
                            </AccessibleButton>
                        </div>
                    ))}
                    <div style={{ marginTop: "12px" }}>
                        <AccessibleButton kind="primary" disabled={logins === null} onClick={() => void startLink()}>
                            {_t("gspcoms_whatsapp|connect")}
                        </AccessibleButton>
                    </div>
                </div>
            );
    }

    return (
        <SettingsTab>
            <SettingsSection heading={_t("gspcoms_whatsapp|title")}>
                <SettingsSubsection heading={_t("gspcoms_whatsapp|section")} description={_t("gspcoms_whatsapp|intro")}>
                    {body}
                </SettingsSubsection>
            </SettingsSection>
        </SettingsTab>
    );
};

export default WhatsAppUserSettingsTab;
