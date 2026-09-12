(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const SUPABASE_URL = "https://xigwlofqkmiibzbongkn.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_mqppAm9n79xl6rYafzXyNQ_mGVoX3Vd";
    const EMPREENDIMENTO_SLUG = "skl-demo";
    const ORIGEM = "app_corretor";
    const APP_VERSION = "3.0.18";
    if ($("brokerAppVersion")) $("brokerAppVersion").textContent = APP_VERSION;
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true
        }
    });
    window.SKLPush = {
        onToken: async token => {
            if (!token) return;
            try {
                const {data: userData} = await sb.auth.getUser();
                if (!userData?.user) return;
                await sb.from("push_tokens").upsert({
                    usuario_id: userData.user.id,
                    token: token,
                    plataforma: "android",
                    atualizado_em: (new Date).toISOString()
                }, {
                    onConflict: "token"
                });
            } catch (error) {
                console.error("Falha ao registrar token de notificação:", error);
            }
        }
    };
    const authView = $("authView");
    const loginForm = $("brokerLoginForm");
    const activationForm = $("brokerActivationForm");
    const accountDialog = $("commercialDialog");
    const requestDialog = $("requestDialog");
    const requestsDialog = $("myRequestsDialog");
    let empreendimentoId = null;
    let lotesChannel = null;
    let solicitacoesChannel = null;
    let online = false;
    function setMessage(element, message, isError = true) {
        element.textContent = message;
        element.classList.toggle("success", !isError);
        element.hidden = !message;
    }
    function showAuthForm(form) {
        [ loginForm, activationForm ].forEach(item => {
            item.hidden = item !== form;
        });
    }
    function showLogin(message = "") {
        authView.hidden = false;
        showAuthForm(loginForm);
        if (message) setMessage($("brokerLoginMessage"), message);
    }
    function enterApp() {
        authView.hidden = true;
        sb.auth.getUser().then(({data: data}) => {
            $("brokerAccountName").textContent = data?.user?.user_metadata?.nome_exibicao || "Corretor";
        });
        updateConnection(true);
        sync(false);
        openRealtime();
        window.NativeBridge?.requestPushToken?.();
        sb.from("mapas_3d").select("id").eq("empreendimento_id", empreendimentoId).eq("ativo", true).maybeSingle().then(({data: mapa3d}) => {
            if (mapa3d) window.SKLApp.showMapa3DButton?.();
        });
        Promise.all([
            sb.from("planos_pagamento").select("id", { count: "exact", head: true }).eq("empreendimento_id", empreendimentoId).eq("ativo", true),
            sb.from("dados_bancarios_cobranca").select("id", { count: "exact", head: true }).eq("empreendimento_id", empreendimentoId).eq("ativo", true)
        ]).then(([planosRes, bancosRes]) => {
            if ((planosRes.count || 0) > 0 || (bancosRes.count || 0) > 0) window.SKLApp.showPaymentInfoButton?.();
        });
    }
    function updateConnection(isOnline, text) {
        online = Boolean(isOnline);
        $("brokerConnectionText").textContent = text || (online ? "Conectado à Central" : "Sem conexão com a Central");
        $("connectionBadge").textContent = online ? "Central sincronizada · imagem de satélite" : "Sem conexão com a Central · dados em cache";
    }
    async function verificarAcesso() {
        const {data: emp, error: empError} = await sb.from("empreendimentos").select("id").eq("slug", EMPREENDIMENTO_SLUG).maybeSingle();
        if (empError || !emp) throw new Error("Empreendimento não encontrado ou sem acesso.");
        const {data: userData} = await sb.auth.getUser();
        const {data: vinculo, error: vinculoError} = await sb.from("empreendimento_usuarios").select("papel, expira_em, senha_temporaria").eq("empreendimento_id", emp.id).eq("usuario_id", userData.user.id).eq("ativo", true).maybeSingle();
        if (vinculoError || !vinculo || vinculo.papel !== "corretor") {
            throw new Error("Este acesso não pertence a um corretor.");
        }
        if (vinculo.expira_em && new Date(vinculo.expira_em).getTime() < Date.now()) {
            throw new Error(`Seu acesso expirou em ${new Date(vinculo.expira_em).toLocaleString("pt-BR")}. Fale com a central.`);
        }
        return {id: emp.id, senhaTemporaria: Boolean(vinculo.senha_temporaria)};
    }
    const forcePasswordDialog = $("forcePasswordDialog");
    function pedirTrocaSenha() {
        return new Promise(resolve => {
            setMessage($("forcePasswordMessage"), "");
            $("forcePasswordInput").value = "";
            $("forcePasswordConfirmInput").value = "";
            forcePasswordDialog.showModal();
            const onCancel = event => event.preventDefault();
            forcePasswordDialog.addEventListener("cancel", onCancel);
            $("submitForcePasswordButton").onclick = async () => {
                const senha = $("forcePasswordInput").value;
                const confirmacao = $("forcePasswordConfirmInput").value;
                if (senha.length < 6) return setMessage($("forcePasswordMessage"), "A senha deve ter pelo menos 6 caracteres.");
                if (senha !== confirmacao) return setMessage($("forcePasswordMessage"), "As senhas não coincidem.");
                try {
                    const {error: updateError} = await sb.auth.updateUser({password: senha});
                    if (updateError) throw updateError;
                    const {error: rpcError} = await sb.rpc("marcar_senha_trocada", {p_empreendimento_id: empreendimentoId});
                    if (rpcError) throw rpcError;
                    forcePasswordDialog.removeEventListener("cancel", onCancel);
                    forcePasswordDialog.close();
                    resolve();
                } catch (error) {
                    setMessage($("forcePasswordMessage"), traduzErro(error.message));
                }
            };
        });
    }
    async function restoreSession() {
        const {data: data} = await sb.auth.getSession();
        if (!data?.session) return showLogin();
        try {
            const acesso = await verificarAcesso();
            empreendimentoId = acesso.id;
            if (acesso.senhaTemporaria) await pedirTrocaSenha();
            enterApp();
        } catch (error) {
            await sb.auth.signOut();
            showLogin(error.message || "Entre novamente.");
        }
    }
    async function sync(showFeedback = false) {
        if (!empreendimentoId) return;
        try {
            const {data: lotes, error: error} = await sb.from("lotes").select("chave, quadra, lote, status, valor, observacao, cliente, version, updated_at, updated_by").eq("empreendimento_id", empreendimentoId);
            if (error) throw error;
            const mapped = lotes.map(lote => ({
                ...lote,
                key: lote.chave
            }));
            const serverTime = (new Date).toISOString();
            const count = window.SKLApp.setRemoteLots(mapped, serverTime);
            $("brokerLastSync").textContent = new Date(serverTime).toLocaleString("pt-BR");
            updateConnection(true);
            if (showFeedback) window.SKLApp.showToast(`${count} lotes atualizados pela Central.`);
        } catch (error) {
            updateConnection(false, "Não foi possível alcançar a Central");
            if (showFeedback) window.SKLApp.showToast(error.message);
        }
    }
    function closeRealtime() {
        if (lotesChannel) sb.removeChannel(lotesChannel);
        if (solicitacoesChannel) sb.removeChannel(solicitacoesChannel);
        lotesChannel = null;
        solicitacoesChannel = null;
    }
    function openRealtime() {
        closeRealtime();
        if (!empreendimentoId) return;
        lotesChannel = sb.channel("corretor-lotes").on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "lotes",
            filter: `empreendimento_id=eq.${empreendimentoId}`
        }, payload => {
            const lote = payload.new;
            window.SKLApp.setRemoteLot({
                ...lote,
                key: lote.chave
            }, (new Date).toISOString());
            window.SKLApp.updateMapa3DStatus?.(lote.id, lote.status);
            $("brokerLastSync").textContent = (new Date).toLocaleString("pt-BR");
        }).subscribe(status => {
            if (status === "SUBSCRIBED") updateConnection(true); else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") updateConnection(false, "Reconectando à Central…");
        });
        solicitacoesChannel = sb.channel("corretor-solicitacoes").on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "solicitacoes",
            filter: `empreendimento_id=eq.${empreendimentoId}`
        }, () => {
            window.SKLApp.showToast("A Central atualizou uma solicitação sua.");
            if (requestsDialog.open) loadMyRequests();
        }).subscribe();
    }
    loginForm.addEventListener("submit", async event => {
        event.preventDefault();
        setMessage($("brokerLoginMessage"), "");
        try {
            const {error: loginError} = await sb.auth.signInWithPassword({
                email: $("brokerEmailInput").value.trim(),
                password: $("brokerPasswordInput").value
            });
            if (loginError) throw loginError;
            const acesso = await verificarAcesso();
            empreendimentoId = acesso.id;
            $("brokerPasswordInput").value = "";
            if (acesso.senhaTemporaria) await pedirTrocaSenha();
            enterApp();
        } catch (error) {
            await sb.auth.signOut();
            setMessage($("brokerLoginMessage"), traduzErro(error.message));
        }
    });
    $("showBrokerActivation").addEventListener("click", () => showAuthForm(activationForm));
    document.querySelectorAll(".back-auth").forEach(button => button.addEventListener("click", () => showAuthForm(loginForm)));
    activationForm.addEventListener("submit", async event => {
        event.preventDefault();
        setMessage($("brokerActivationMessage"), "");
        const email = $("brokerNewEmail").value.trim();
        const password = $("brokerNewPassword").value;
        try {
            await invokeConvites({
                action: "ativar_convite",
                token: $("brokerInviteInput").value.trim(),
                email: email,
                password: password
            });
            const {error: loginError} = await sb.auth.signInWithPassword({
                email: email,
                password: password
            });
            if (loginError) throw loginError;
            const acesso = await verificarAcesso();
            empreendimentoId = acesso.id;
            if (acesso.senhaTemporaria) await pedirTrocaSenha();
            enterApp();
        } catch (error) {
            setMessage($("brokerActivationMessage"), traduzErro(error.message));
        }
    });
    $("requestLotButton").addEventListener("click", () => {
        const lot = window.SKLApp.getSelectedLot();
        if (!lot) return window.SKLApp.showToast("Selecione um lote primeiro.");
        if (!online) return window.SKLApp.showToast("É preciso estar conectado para enviar uma solicitação.");
        if ([ "vendido", "bloqueado" ].includes(lot.record.status)) return window.SKLApp.showToast("Este lote está indisponível.");
        $("requestLotTitle").textContent = `Quadra ${lot.quadra} · Lote ${lot.lote}`;
        setMessage($("requestMessage"), "");
        requestDialog.showModal();
    });
    $("submitRequestButton").addEventListener("click", async () => {
        const lot = window.SKLApp.getSelectedLot();
        if (!lot) return;
        const customer = $("requestCustomerInput").value.trim();
        if (customer.length < 3) return setMessage($("requestMessage"), "Informe o nome do cliente.");
        try {
            const {data: loteRow, error: loteError} = await sb.from("lotes").select("id").eq("empreendimento_id", empreendimentoId).eq("chave", lot.lot_key).single();
            if (loteError || !loteRow) throw new Error("Lote não encontrado.");
            const {error: error} = await sb.rpc("criar_solicitacao", {
                p_lote_id: loteRow.id,
                p_tipo: $("requestTypeInput").value,
                p_cliente_nome: customer,
                p_cliente_telefone: $("requestPhoneInput").value,
                p_observacao: $("requestNoteInput").value,
                p_origem_offline: false
            });
            if (error) throw error;
            [ $("requestCustomerInput"), $("requestPhoneInput"), $("requestNoteInput") ].forEach(input => {
                input.value = "";
            });
            requestDialog.close();
            window.SKLApp.showToast("Solicitação enviada à Central de Vendas.");
        } catch (error) {
            setMessage($("requestMessage"), traduzErro(error.message));
        }
    });
    function requestStatusLabel(status) {
        return {
            pendente: "Pendente",
            aprovada: "Aprovada",
            rejeitada: "Rejeitada"
        }[status] || status;
    }
    function requestTypeLabel(type) {
        return type === "reserva" ? "Reserva" : "Indicação de venda";
    }
    async function loadMyRequests() {
        const list = $("myRequestsList");
        list.innerHTML = '<p class="empty-state">Carregando…</p>';
        try {
            const {data: requests, error: error} = await sb.from("solicitacoes").select("id, tipo, cliente_nome, status, created_at, lote_id, lotes(chave, quadra, lote)").eq("empreendimento_id", empreendimentoId).order("created_at", {
                ascending: false
            });
            if (error) throw error;
            list.replaceChildren();
            if (!requests.length) list.innerHTML = '<p class="empty-state">Você ainda não enviou solicitações.</p>';
            requests.forEach(item => {
                const card = document.createElement("article");
                card.className = `request-record request-${item.status}`;
                card.innerHTML = `<div><strong>Quadra ${escapeHtml(item.lotes?.quadra)} · Lote ${escapeHtml(item.lotes?.lote)}</strong><span>${escapeHtml(requestTypeLabel(item.tipo))}</span></div><strong>${escapeHtml(requestStatusLabel(item.status))}</strong><p>Cliente: ${escapeHtml(item.cliente_nome)}</p><small>Enviada em ${new Date(item.created_at).toLocaleString("pt-BR")}</small>`;
                list.append(card);
            });
        } catch (error) {
            list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
        }
    }
    $("myRequestsButton").addEventListener("click", () => {
        accountDialog.close();
        requestsDialog.showModal();
        loadMyRequests();
    });
    const COMMISSION_STATUS_LABEL = { pendente: "Pendente", aprovada: "Aprovada", paga: "Paga", cancelada: "Cancelada" };
    function commissionStatusPillClass(status) {
        if (status === "paga") return "disponivel";
        if (status === "cancelada") return "vendido";
        if (status === "aprovada") return "reservado";
        return "nao_informado";
    }
    function formatMoneyBR(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "—";
        return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    }
    async function loadMyCommissions() {
        const list = $("myCommissionsList");
        list.innerHTML = '<p class="empty-state">Carregando…</p>';
        try {
            const {data: userData} = await sb.auth.getUser();
            const {data: rows, error: error} = await sb.from("comissoes").select("id, valor_venda, percentual, valor_comissao, status, criado_em, pago_em").eq("empreendimento_id", empreendimentoId).eq("corretor_id", userData.user.id).order("criado_em", { ascending: false });
            if (error) throw error;
            list.replaceChildren();
            if (!rows.length) list.innerHTML = '<p class="empty-state">Nenhuma venda registrada ainda.</p>';
            rows.forEach(item => {
                const card = document.createElement("article");
                card.className = "request-record";
                const dataInfo = item.status === "paga" && item.pago_em ? `Paga em ${new Date(item.pago_em).toLocaleDateString("pt-BR")}` : `Registrada em ${new Date(item.criado_em).toLocaleDateString("pt-BR")}`;
                card.innerHTML = `<div><strong>Venda: ${formatMoneyBR(item.valor_venda)}</strong><span class="status-badge status-${commissionStatusPillClass(item.status)}">${escapeHtml(COMMISSION_STATUS_LABEL[item.status] || item.status)}</span></div><p>Comissão: <strong>${formatMoneyBR(item.valor_comissao)}</strong>${item.percentual ? ` (${item.percentual}%)` : ""}</p><small>${dataInfo}</small>`;
                list.append(card);
            });
        } catch (error) {
            list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
        }
    }
    $("myCommissionsButton").addEventListener("click", () => {
        accountDialog.close();
        $("myCommissionsDialog").showModal();
        loadMyCommissions();
    });
    $("syncStatusButton").addEventListener("click", () => sync(true));
    $("brokerChangePasswordButton").addEventListener("click", async () => {
        try {
            const novaSenha = $("brokerChangedPassword").value;
            const {error: error} = await sb.auth.updateUser({
                password: novaSenha
            });
            if (error) throw error;
            $("brokerChangedPassword").value = "";
            window.SKLApp.showToast("Senha alterada com segurança.");
        } catch (error) {
            window.SKLApp.showToast(traduzErro(error.message));
        }
    });
    $("brokerLogoutButton").addEventListener("click", async () => {
        if (accountDialog.open) accountDialog.close();
        closeRealtime();
        empreendimentoId = null;
        await sb.auth.signOut();
        showLogin("Você saiu deste aparelho.");
    });
    async function openMemorial(quadra, lote, title) {
        if (!empreendimentoId) return window.SKLApp.showToast("Entre na sua conta para abrir o memorial.");
        try {
            const path = `${empreendimentoId}/${quadra}/${lote}.pdf`;
            const {data: blob, error: error} = await sb.storage.from("memoriais").download(path);
            if (error) throw error;
            if (window.NativeBridge?.openMemorialData) {
                const base64 = await blobToBase64(blob);
                window.NativeBridge.openMemorialData(base64, title);
                return;
            }
            const url = URL.createObjectURL(blob);
            window.open(url, "_blank", "noopener");
        } catch (error) {
            window.SKLApp.showToast("Memorial ainda não disponível para este lote.");
        }
    }
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader;
            reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    function traduzErro(message) {
        const mapa = {
            "Invalid login credentials": "E-mail ou senha incorretos.",
            "Email not confirmed": "E-mail ainda não confirmado.",
            "A user with this email address has already been registered": "Já existe um usuário com esse e-mail — fale com a central.",
            "User already registered": "Já existe um usuário com esse e-mail — fale com a central."
        };
        return mapa[message] || message || "Não foi possível concluir a operação.";
    }
    async function invokeConvites(body) {
        const {data: data, error: error} = await sb.functions.invoke("convites", {
            body: body
        });
        if (error) {
            let message = error.message;
            if (error.context && typeof error.context.json === "function") {
                try {
                    const payload = await error.context.json();
                    message = payload.message || payload.error || message;
                } catch {}
            }
            throw new Error(message);
        }
        if (data?.error) throw new Error(data.message || data.error);
        return data;
    }
    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        }[character]));
    }
    window.addEventListener("online", () => {
        if (empreendimentoId) {
            sync(false);
            openRealtime();
        }
    });
    window.addEventListener("offline", () => {
        updateConnection(false, "Modo offline · dados em cache");
        closeRealtime();
    });
    async function carregarMapa3D() {
        if (!empreendimentoId) return null;
        const {data: mapa, error: mapaError} = await sb.from("mapas_3d").select("imagem_url, largura_px, altura_px, pontos").eq("empreendimento_id", empreendimentoId).eq("ativo", true).maybeSingle();
        if (mapaError || !mapa) return null;
        const {data: lotesRows, error: lotesError} = await sb.from("lotes").select("id, quadra, lote, status").eq("empreendimento_id", empreendimentoId);
        if (lotesError) return null;
        const quadraLotePorId = new Map;
        const statusPorId = new Map;
        (lotesRows || []).forEach(l => {
            quadraLotePorId.set(l.id, {
                quadra: l.quadra,
                lote: l.lote
            });
            statusPorId.set(l.id, l.status);
        });
        return {
            ...mapa,
            quadraLotePorId: quadraLotePorId,
            statusPorId: statusPorId
        };
    }
    async function carregarFormasPagamento() {
        if (!empreendimentoId) return null;
        const {data: planos, error: planosError} = await sb.from("planos_pagamento").select("id, nome, descricao, planos_pagamento_series(id, tipo, quantidade_parcelas, indexador, portador_cobranca, valor_total, observacao, ordem)").eq("empreendimento_id", empreendimentoId).eq("ativo", true).order("criado_em");
        const {data: bancos, error: bancosError} = await sb.from("dados_bancarios_cobranca").select("id, tipo, banco_nome, agencia, conta, titular, documento_titular, chave_pix, instrucoes, ordem").eq("empreendimento_id", empreendimentoId).eq("ativo", true).order("ordem");
        if (planosError && bancosError) return null;
        const planosList = (planos || []).map(p => ({
            ...p,
            planos_pagamento_series: (p.planos_pagamento_series || []).slice().sort((a, b) => a.ordem - b.ordem)
        }));
        if (planosList.length === 0 && (!bancos || bancos.length === 0)) return null;
        return {
            planos: planosList,
            bancos: bancos || []
        };
    }
    window.SKLOnline = {
        sync: sync,
        openMemorial: openMemorial,
        carregarMapa3D: carregarMapa3D,
        carregarFormasPagamento: carregarFormasPagamento
    };
    restoreSession();
})();