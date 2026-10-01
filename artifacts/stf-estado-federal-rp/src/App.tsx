import { useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/clerk-react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Route, Switch, Link, useLocation, Router as WouterRouter } from 'wouter';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, CircleAlert,
  FileCheck2, FilePlus2, FileText, Gavel, Landmark, LayoutDashboard, LockKeyhole,
  LogOut, Paperclip, Settings2, Shield, Upload, X,
} from 'lucide-react';
import {
  useGetMyProfile, useGetPublicSummary, useGetPublishedDecisions, useListProcesses,
  useCreateProcess, useGetProcess, useSubmitVote, useSubmitAdditionalInformation,
  useGetAdminDashboard, useListUsers, useListMinisters, useAssignMinister,
  useUpdateUserRole, useUpdateProcessStatus, useStartTrial, usePublishDecision,
  useGetSystemSettings, useUpdateSystemSettings, useListAuditLogs,
  useSetTelegramWebhook, useRequestUploadUrl,
  getGetMyProfileQueryKey, getGetPublicSummaryQueryKey, getGetPublishedDecisionsQueryKey,
  getListProcessesQueryKey, getGetProcessQueryKey, getGetAdminDashboardQueryKey,
  getListUsersQueryKey, getListMinistersQueryKey, getGetSystemSettingsQueryKey,
  getListAuditLogsQueryKey,
} from '@workspace/api-client-react';
import type {
  AdminDashboard, AdminUser, AuditLog, ProcessListItem, ProcessStatus,
  PublishedDecision, SystemSettings, UserProfile,
} from '@workspace/api-client-react';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 1 } } });
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
const roles: Record<string, string> = { 'CIDADÃO': 'Cidadão', MINISTRO: 'Ministro', ADMINISTRADOR: 'Administrador' };
const statusHuman: Record<string, string> = {
  Recebida: 'Recebida', 'Em triagem': 'Em triagem', 'Aguardando julgamento': 'Aguardando julgamento',
  'Em julgamento': 'Em julgamento', 'Julgamento concluído': 'Julgamento concluído',
  Arquivada: 'Arquivada', Procedente: 'Procedente', Improcedente: 'Improcedente',
  'Aguardando informações': 'Aguardando informações',
};

function prettyDate(value?: string | null) {
  if (!value) return 'Não definido';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(date);
}
function prettyTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
function cx(...values: Array<string | false | undefined>) { return values.filter(Boolean).join(' '); }

function Seal({ small = false }: { small?: boolean }) {
  return <span className={cx('seal', small && 'seal-small')} aria-hidden="true"><Landmark size={small ? 14 : 17} strokeWidth={1.5} /></span>;
}
function Brand({ light = false }: { light?: boolean }) {
  return <Link href="/" className={cx('brand', light && 'brand-light')} aria-label="Página inicial do Supremo Tribunal Federal">
    <Seal /><span>SUPREMO TRIBUNAL FEDERAL<small>ESTADO FEDERAL DO RP</small></span>
  </Link>;
}
function RPBadge() { return <span className="notice-rp"><Shield size={12} /> AMBIENTE FICCIONAL · RP</span>; }
function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="panel card-pad" aria-label="Carregando conteúdo">{Array.from({ length: count }, (_, i) =>
    <div key={i} style={{ marginBottom: 18 }}><div className="skeleton" style={{ width: `${70 + (i % 3) * 9}%`, marginBottom: 9 }} /><div className="skeleton" style={{ width: '42%', height: 10 }} /></div>)}</div>;
}
function ErrorState({ retry, message = 'Não foi possível carregar estas informações.' }: { retry: () => void; message?: string }) {
  return <div className="error-box" role="alert"><CircleAlert size={15} style={{ verticalAlign: 'middle', marginRight: 7 }} />{message} <button className="text-button" onClick={retry}>Tentar novamente</button></div>;
}
function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-mark"><FileText size={19} /></div><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
function PageTitle({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action}</div>;
}
function StatusPill({ status }: { status: string }) {
  const color = ['Procedente', 'Julgamento concluído'].includes(status) ? 'green' : ['Em julgamento', 'Aguardando julgamento'].includes(status) ? 'gold' : ['Em triagem'].includes(status) ? 'blue' : '';
  return <span className={cx('status', color)}>{statusHuman[status] ?? status}</span>;
}
function ErrorView({ retry }: { retry: () => void }) {
  return <div className="empty"><div className="empty-mark"><CircleAlert size={18} /></div><strong>Algo não saiu como esperado</strong><p>Verifique sua conexão e tente novamente.</p><button className="btn btn-light" onClick={retry}>Tentar novamente</button></div>;
}

function PublicHome() {
  const summary = useGetPublicSummary();
  const decisions = useGetPublishedDecisions();
  return <div className="app">
    <header className="public-header">
      <div className="wrap">
        <nav className="public-nav"><Brand /><div className="navlinks"><Link href="/decisoes">Decisões</Link><Link href="/portal" className="nav-cta">Acessar o portal <ArrowRight size={14} /></Link></div></nav>
        <section className="hero fade-in">
          <span className="eyebrow">JUSTIÇA CONSTITUCIONAL · ESTADO FEDERAL DO RP</span>
          <h1 className="serif">A lei se faz pública.<br />A justiça, acompanhada.</h1>
          <p>Consulte decisões, acompanhe processos e acesse os serviços do Supremo Tribunal Federal do Estado Federal do RP.</p>
          <Link href="/portal" className="btn">Acessar área do cidadão <ArrowRight size={15} /></Link>
          <div className="rp-note"><Shield size={16} /> Este portal é uma simulação para roleplay (RP). Não representa uma instituição oficial nem oferece orientação jurídica.</div>
        </section>
      </div>
    </header>
    <main className="wrap public-content">
      <div className="stats">
        {summary.isLoading ? Array.from({ length: 4 }, (_, i) => <div className="stat" key={i}><div className="skeleton" style={{ width: 58, height: 28, marginBottom: 10 }} /><div className="skeleton" style={{ width: 110, height: 9 }} /></div>) :
          summary.isError ? <div className="panel card-pad" style={{ gridColumn: '1/-1' }}><ErrorState retry={() => summary.refetch()} /></div> :
            [
              ['Processos registrados', summary.data?.totalProcesses],
              ['Decisões publicadas', summary.data?.publishedDecisions],
              ['Em julgamento', summary.data?.inJudgment],
              ['Assentos ministeriais', summary.data?.ministers],
            ].map(([label, value]) => <div className="stat" key={String(label)}><strong>{value ?? '—'}</strong><span>{label}</span></div>)}
      </div>
      <section style={{ marginTop: 52 }}>
        <div className="section-heading"><div><span className="eyebrow">TRANSPARÊNCIA</span><h2>Decisões recentes</h2><p>Publicações oficiais dentro deste ambiente de roleplay.</p></div><Link href="/decisoes" className="btn btn-light">Todas as decisões <ArrowRight size={14} /></Link></div>
        <DecisionList data={decisions.data ?? []} loading={decisions.isLoading} error={decisions.isError} retry={() => decisions.refetch()} compact />
      </section>
      <section className="steps-section">
        <div><span className="eyebrow">COMO FUNCIONA</span><h2 className="serif">Um rito claro.<br />Uma decisão colegiada.</h2></div>
        <div className="steps">
          {[['01', 'Protocolo', 'A denúncia é registrada com fatos e documentos de apoio.'], ['02', 'Análise', 'O processo segue para triagem e é distribuído ao colegiado.'], ['03', 'Votação', 'Cinco ministros registram votos independentes.'], ['04', 'Publicação', 'A decisão final torna-se pública para consulta.']].map(([n, title, body]) =>
            <div className="step" key={n}><span>{n}</span><div><strong>{title}</strong><p>{body}</p></div></div>)}
        </div>
      </section>
    </main>
    <footer className="public-footer"><div className="wrap"><Brand /><span>Portal de roleplay. Conteúdo ficcional, sem validade legal.</span></div></footer>
    <RPBadge />
  </div>;
}

function DecisionList({ data, loading, error, retry, compact = false }: { data: PublishedDecision[]; loading: boolean; error: boolean; retry: () => void; compact?: boolean }) {
  if (loading) return <LoadingRows count={compact ? 3 : 5} />;
  if (error) return <div className="panel card-pad"><ErrorState retry={retry} /></div>;
  if (!data.length) return <div className="panel"><EmptyState title="Ainda não há decisões publicadas." /></div>;
  return <div className="panel decision-list">{data.slice(0, compact ? 4 : undefined).map((d) =>
    <article className="decision" key={d.id} data-testid={`decision-${d.id}`}>
      <div className="decision-date">{prettyDate(d.publishedAt)}</div>
      <div><h3>{d.subject}</h3><p>{d.processNumber} · {d.category}<br />{compact ? d.summary : d.summary}</p></div>
      <span className={cx('outcome', d.outcome === 'IMPROCEDENTE' && 'bad')}>{d.outcome === 'PROCEDENTE' ? 'Procedente' : d.outcome === 'EMPATE' ? 'Empate' : 'Improcedente'}</span>
    </article>)}</div>;
}

function SignInPage() {
  return <div className="auth-wrap"><div className="auth-card"><Brand /><h1 className="serif">Área de acesso</h1><p className="auth-sub">Entre para acompanhar ou administrar processos no portal do STF do Estado Federal do RP.</p><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/portal" /></div><RPBadge /></div>;
}
function SignUpPage() {
  return <div className="auth-wrap"><div className="auth-card"><Brand /><h1 className="serif">Criar acesso</h1><p className="auth-sub">O cadastro permite participar deste ambiente ficcional de roleplay.</p><SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/portal" /></div><RPBadge /></div>;
}

const navBase = [
  { href: '/portal', label: 'Visão geral', icon: LayoutDashboard },
  { href: '/decisoes', label: 'Decisões públicas', icon: BookOpen },
  { href: '/denuncias/nova', label: 'Nova denúncia', icon: FilePlus2 },
];
function WorkspaceLayout({ profile, children }: { profile: UserProfile; children: ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const items = [...navBase, ...(profile.role === 'ADMINISTRADOR' ? [{ href: '/admin', label: 'Administração', icon: Settings2 }] : [])];
  return <div className="app">
    <header className="workspace-head"><div className="wrap"><div className="head-line"><Brand light /><div className="user-chip"><span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span><span className="user-details">{profile.name}<small>{roles[profile.role] ?? profile.role}{profile.ministerSeat ? ` · Assento ${profile.ministerSeat}` : ''}</small></span><button type="button" className="signout" aria-label="Sair" onClick={() => void signOut({ redirectUrl: '/' })}><LogOut size={15} /></button></div></div></div></header>
    <div className="workspace-shell">
      <aside className="sidebar"><div className="sidebar-label">Portal</div><nav className="side-links">{items.map((item) => { const Icon = item.icon; return <Link key={item.href} href={item.href} className={cx('side-link', location === item.href && 'active')}><Icon size={16} />{item.label}</Link>; })}</nav><div className="side-foot"><Shield size={14} /> Área reservada<br />Acesso conforme perfil institucional.</div></aside>
      <nav className="mobile-nav">{items.map((item) => { const Icon = item.icon; return <Link key={item.href} href={item.href} className={cx('side-link', location === item.href && 'active')}><Icon size={15} />{item.label}</Link>; })}</nav>
      <main className="main-area">{children}</main>
    </div><RPBadge />
  </div>;
}
function ProfileGate({ children }: { children: (profile: UserProfile) => ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const profile = useGetMyProfile({ query: { enabled: isLoaded && !!isSignedIn, queryKey: getGetMyProfileQueryKey() } });
  if (!isLoaded || (isSignedIn && profile.isLoading)) return <div className="app profile-loading"><div className="panel card-pad"><div className="skeleton" style={{ width: 210, height: 20 }} /><div className="skeleton" style={{ width: 150, marginTop: 14 }} /></div></div>;
  if (!isSignedIn) return <SignInPrompt />;
  if (profile.isError || !profile.data) return <div className="app profile-loading"><div className="panel card-pad"><ErrorState retry={() => profile.refetch()} message="Não foi possível validar seu perfil de acesso." /></div></div>;
  return <>{children(profile.data)}</>;
}
function SignInPrompt() {
  return <div className="app public-prompt"><header className="workspace-head"><div className="wrap"><Brand light /></div></header><main className="prompt-card"><div className="empty-mark"><LockKeyhole size={20} /></div><h1 className="serif">Acesso reservado</h1><p>Entre na sua conta para acessar a área de processos.</p><Link href="/sign-in" className="btn btn-primary">Entrar no portal <ArrowRight size={14} /></Link><Link href="/" className="back-link"><ArrowLeft size={14} /> Voltar à página pública</Link></main><RPBadge /></div>;
}
function PortalRoute() {
  return <ProfileGate>{(profile) => <WorkspaceLayout profile={profile}><PortalDashboard profile={profile} /></WorkspaceLayout>}</ProfileGate>;
}
function PortalDashboard({ profile }: { profile: UserProfile }) {
  const list = useListProcesses(undefined, { query: { enabled: true, queryKey: getListProcessesQueryKey() } });
  const isAdmin = profile.role === 'ADMINISTRADOR';
  const admin = useGetAdminDashboard({ query: { enabled: isAdmin, queryKey: getGetAdminDashboardQueryKey() } });
  const mine = list.data ?? [];
  const title = profile.role === 'MINISTRO' ? 'Painel ministerial' : profile.role === 'ADMINISTRADOR' ? 'Painel administrativo' : 'Área do cidadão';
  return <>
    <PageTitle eyebrow={roles[profile.role] ?? 'Portal'} title={`Bem-vindo, ${profile.name.split(' ')[0]}`} detail={title} action={profile.role === 'CIDADÃO' && <Link href="/denuncias/nova" className="btn btn-primary"><FilePlus2 size={15} /> Registrar denúncia</Link>} />
    <div className="welcome-note"><div className="note-mark"><Landmark size={17} /></div><div><strong>{profile.role === 'MINISTRO' ? 'Sua independência é essencial.' : 'Acompanhe cada etapa com clareza.'}</strong><p>{profile.role === 'MINISTRO' ? 'Votos e fundamentos permanecem reservados até a conclusão da votação colegiada.' : 'Este ambiente de roleplay registra denúncias e decisões ficcionais. Nenhuma informação tem validade fora do RP.'}</p></div></div>
    {isAdmin && admin.isLoading && <LoadingRows count={2} />}
    {isAdmin && admin.isError && <ErrorState retry={() => admin.refetch()} />}
    {isAdmin && admin.data && <div className="stats workspace-stats">{[['Processos', admin.data.totalProcesses], ['Recebidas', admin.data.received], ['Em julgamento', admin.data.inJudgment], ['Concluídas', admin.data.concluded]].map(([label, value]) => <div className="stat" key={String(label)}><strong>{value}</strong><span>{label}</span></div>)}</div>}
    <section className="dashboard-section"><div className="section-heading"><div><span className="eyebrow">ACOMPANHAMENTO</span><h2>Processos visíveis</h2><p>Os registros disponíveis ao seu perfil.</p></div></div>
      {list.isLoading ? <LoadingRows /> : list.isError ? <ErrorState retry={() => list.refetch()} /> : !mine.length ? <div className="panel"><EmptyState title="Nenhum processo para exibir." >Quando houver movimentações vinculadas ao seu perfil, elas aparecerão aqui.</EmptyState></div> : <ProcessTable items={mine} />}
    </section>
  </>;
}
function ProcessTable({ items }: { items: ProcessListItem[] }) {
  return <div className="panel table-wrap"><table><thead><tr><th>Processo</th><th>Assunto</th><th>Parte acusada</th><th>Status</th><th>Prazo</th><th></th></tr></thead><tbody>{items.map((p) =>
    <tr key={p.id} data-testid={`row-process-${p.id}`}><td><strong>{p.processNumber}</strong></td><td>{p.subject}</td><td>{p.accusedName}</td><td><StatusPill status={p.status} /></td><td>{prettyDate(p.deadlineAt)}</td><td><Link href={`/processos/${p.id}`} className="table-link">Abrir <ArrowRight size={13} /></Link></td></tr>)}</tbody></table></div>;
}

function ComplaintRoute() {
  return <ProfileGate>{(profile) => <WorkspaceLayout profile={profile}><ComplaintForm profile={profile} /></WorkspaceLayout>}</ProfileGate>;
}
function ComplaintForm({ profile }: { profile: UserProfile }) {
  const create = useCreateProcess();
  const requestUpload = useRequestUploadUrl();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const [accusedName, setAccused] = useState('');
  const [category, setCategory] = useState('');
  const [subject, setSubject] = useState('');
  const [facts, setFacts] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSuccess('');
    if (facts.trim().length < 20) { setError('Descreva os fatos em pelo menos 20 caracteres.'); return; }
    setUploading(true);
    try {
      const attachments: Array<{ objectPath: string; name: string; contentType: string; size: number }> = [];
      for (const file of files) {
        const contentType = file.type || 'application/octet-stream';
        const signed = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType } });
        const response = await fetch(signed.uploadURL, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
        if (!response.ok) throw new Error(`Não foi possível enviar ${file.name}.`);
        attachments.push({ objectPath: signed.objectPath, name: file.name, contentType, size: file.size });
      }
      const created = await create.mutateAsync({ data: { accusedName: accusedName.trim(), category, subject: subject.trim(), facts: facts.trim(), attachments } });
      await Promise.all([
        client.invalidateQueries({ queryKey: getListProcessesQueryKey() }),
        client.invalidateQueries({ queryKey: getGetPublicSummaryQueryKey() }),
      ]);
      setSuccess('Denúncia protocolada com sucesso. Abrindo o processo…');
      setLocation(`/processos/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível protocolar a denúncia. Revise os dados e tente novamente.');
    } finally { setUploading(false); }
  }
  return <><PageTitle eyebrow="PROTOCOLO DIGITAL" title="Registrar denúncia" detail="Informe os fatos com clareza. Campos marcados são obrigatórios." /><div className="notice" style={{ marginBottom: 18 }}><Shield size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} /> Esta denúncia será criada dentro do roleplay. Não envie informações pessoais reais ou conteúdo fora do contexto ficcional.</div>
    <form className="panel card-pad complaint-form" onSubmit={submit} noValidate>
      {error && <div className="error-box" role="alert">{error}</div>}{success && <div className="success-box"><Check size={15} />{success}</div>}
      <div className="form-grid">
        <div className="field"><label htmlFor="accused">Nome da pessoa denunciada *</label><input id="accused" data-testid="input-accused-name" value={accusedName} onChange={(e) => setAccused(e.target.value)} required maxLength={200} placeholder="Nome no roleplay" /></div>
        <div className="field"><label htmlFor="category">Categoria *</label><select id="category" data-testid="select-category" value={category} onChange={(e) => setCategory(e.target.value)} required><option value="">Selecione uma categoria</option>{['Constitucional', 'Administrativa', 'Eleitoral', 'Penal', 'Cível', 'Outra'].map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field form-span"><label htmlFor="subject">Assunto do processo *</label><input id="subject" data-testid="input-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} placeholder="Resumo em uma frase" /></div>
        <div className="field form-span"><label htmlFor="facts">Relato dos fatos *</label><textarea id="facts" data-testid="input-facts" value={facts} onChange={(e) => setFacts(e.target.value)} minLength={20} maxLength={10000} required placeholder="Descreva o que aconteceu, quando e onde. Inclua apenas detalhes relevantes ao caso." /><small>{facts.length}/10.000 caracteres · mínimo de 20</small></div>
        <div className="field form-span"><label htmlFor="evidence">Documentos e evidências</label><label className="upload-box" htmlFor="evidence"><Upload size={18} /><strong>Selecionar arquivos</strong><span>Até 25 MB por arquivo. Os arquivos serão enviados diretamente ao armazenamento seguro.</span></label><input className="file-input" id="evidence" type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} data-testid="input-evidence" />{files.length > 0 && <div className="selected-files">{files.map((file) => <div key={`${file.name}${file.lastModified}`}><Paperclip size={14} />{file.name}<span>{(file.size / 1024 / 1024).toFixed(1)} MB</span><button type="button" aria-label={`Remover ${file.name}`} onClick={() => setFiles(files.filter((f) => f !== file))}><X size={14} /></button></div>)}</div>}</div>
      </div>
      <div className="form-actions"><Link href="/portal" className="btn btn-light">Cancelar</Link><button className="btn btn-primary" data-testid="button-submit-complaint" disabled={create.isPending || uploading || !accusedName || !subject || !category || facts.length < 20}>{uploading ? 'Enviando evidências…' : create.isPending ? 'Protocolando…' : 'Protocolar denúncia'} <ArrowRight size={14} /></button></div>
    </form>
  </>;
}

function ProcessRoute({ params }: { params: { id?: string } }) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return <NotFound />;
  return <ProfileGate>{(profile) => <WorkspaceLayout profile={profile}><ProcessDetailPage id={id} profile={profile} /></WorkspaceLayout>}</ProfileGate>;
}
function ProcessDetailPage({ id, profile }: { id: number; profile: UserProfile }) {
  const process = useGetProcess(id, { query: { enabled: true, queryKey: getGetProcessQueryKey(id) } });
  const voteMutation = useSubmitVote();
  const infoMutation = useSubmitAdditionalInformation();
  const client = useQueryClient();
  const [vote, setVote] = useState(''); const [rationale, setRationale] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  if (process.isLoading) return <LoadingRows count={5} />;
  if (process.isError || !process.data) return <ErrorView retry={() => process.refetch()} />;
  const p = process.data;
  const final = !!p.result || p.status === 'Julgamento concluído' || p.status === 'Procedente' || p.status === 'Improcedente';
  const canVote = profile.role === 'MINISTRO' && p.status === 'Em julgamento' && !p.myVote && !final;
  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey: getGetProcessQueryKey(id) }), client.invalidateQueries({ queryKey: getListProcessesQueryKey() })]);
  }
  async function submitVote(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    if (rationale.trim().length < 10) { setError('A fundamentação deve conter ao menos 10 caracteres.'); return; }
    try {
      await voteMutation.mutateAsync({ processId: id, data: { choice: vote as 'PROCEDENTE' | 'IMPROCEDENTE' | 'PEDIDO_DE_MAIS_INFORMACOES' | 'IMPEDIMENTO', rationale: rationale.trim() } });
      setNotice('Voto registrado. Ele permanecerá reservado até a conclusão da votação colegiada.'); setVote(''); setRationale(''); await refresh();
    } catch { setError('Não foi possível registrar o voto. Verifique o estado do processo e tente novamente.'); }
  }
  async function submitInfo(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    try { await infoMutation.mutateAsync({ processId: id, data: { message: message.trim(), attachments: [] } }); setNotice('Informações complementares registradas.'); setMessage(''); await refresh(); }
    catch { setError('Não foi possível registrar as informações.'); }
  }
  return <>
    <Link href="/portal" className="back-link"><ArrowLeft size={14} /> Voltar ao portal</Link>
    <PageTitle eyebrow={`PROCESSO ${p.processNumber}`} title={p.subject} detail={`${p.category} · Protocolado em ${prettyDate(p.createdAt)}`} />
    {error && <div className="error-box">{error}</div>}{notice && <div className="success-box"><Check size={15} />{notice}</div>}
    <div className="process-grid">
      <div className="process-main">
        <section className="panel card-pad"><div className="section-heading"><div><span className="eyebrow">IDENTIFICAÇÃO</span><h2>Dados do processo</h2></div><StatusPill status={p.status} /></div>
          <div className="process-meta"><div className="meta-block"><span>Parte acusada</span><strong>{p.accusedName}</strong></div><div className="meta-block"><span>Parte denunciante</span><strong>{p.complainantName}</strong></div><div className="meta-block"><span>Prazo vigente</span><strong>{prettyDate(p.deadlineAt)}</strong></div><div className="meta-block"><span>Rodada de votação</span><strong>{p.voteRound || '—'}</strong></div></div>
          <div className="subsection"><span className="eyebrow">RELATO</span><p className="facts-text">{p.facts}</p></div>
        </section>
        <section className="panel card-pad" style={{ marginTop: 17 }}><div className="section-heading"><div><span className="eyebrow">DOCUMENTOS</span><h2>Evidências anexadas</h2></div></div>
          {!p.attachments?.length ? <p className="quiet">Nenhum documento anexado ao processo.</p> : <div className="attachments">{p.attachments.map((file) => <a className="attachment" href={file.url} target="_blank" rel="noreferrer" key={file.id}><FileText size={17} /><span><strong>{file.name}</strong><small>{file.contentType} · {(file.size / 1024 / 1024).toFixed(1)} MB</small></span><ArrowDownToLine size={15} /></a>)}</div>}
        </section>
        {final && <section className="panel card-pad final-result"><span className="eyebrow">RESULTADO COLEGIADO</span><h2>{p.result === 'PROCEDENTE' ? 'Pedido procedente' : p.result === 'EMPATE' ? 'Votação empatada' : 'Pedido improcedente'}</h2><p>{p.decisionSummary || 'A decisão está concluída.'}</p>{p.voteTally && <div className="tally"><strong>{p.voteTally.procedente}</strong> procedentes <span /> <strong>{p.voteTally.improcedente}</strong> improcedentes</div>}</section>}
      </div>
      <aside className="process-side">
        <section className="panel card-pad"><div className="section-heading"><div><span className="eyebrow">COLEGIADO</span><h2>Progresso dos votos</h2></div></div><div className="vote-progress">{p.voteProgress?.map((seat) =>
          <div className="vote-row" key={seat.seat}><span><i className={cx('dot', seat.hasVoted && 'done')} />{seat.ministerName}<small className="seat-label">Assento {seat.seat}</small></span><span className="vote-state">{final ? (seat.hasVoted ? 'Registrado' : 'Sem voto') : (seat.hasVoted ? 'Registrado' : 'Pendente')}{final && seat.votedAt ? <small>{prettyTime(seat.votedAt)}</small> : null}</span></div>)}</div>
          {!final && <p className="quiet privacy-note"><LockKeyhole size={13} /> Votos e fundamentos individuais são reservados até o resultado final.</p>}
        </section>
        {canVote && <form className="panel card-pad action-panel" onSubmit={submitVote}><span className="eyebrow">ÁREA MINISTERIAL</span><h2>Registrar voto</h2><p className="quiet">Seu voto é individual e não poderá ser alterado após o envio.</p><div className="field"><label htmlFor="vote-choice">Voto</label><select id="vote-choice" value={vote} onChange={(e) => setVote(e.target.value)} required><option value="">Selecione</option><option value="PROCEDENTE">Procedente</option><option value="IMPROCEDENTE">Improcedente</option><option value="PEDIDO_DE_MAIS_INFORMACOES">Solicitar mais informações</option><option value="IMPEDIMENTO">Declarar impedimento</option></select></div><div className="field"><label htmlFor="rationale">Fundamentação</label><textarea id="rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} minLength={10} maxLength={5000} required placeholder="Registre sua fundamentação com independência." /></div><button className="btn btn-primary full-btn" disabled={voteMutation.isPending || !vote || rationale.length < 10}>{voteMutation.isPending ? 'Registrando…' : 'Confirmar voto'} <Check size={14} /></button></form>}
        {p.myVote && profile.role === 'MINISTRO' && <div className="panel card-pad"><span className="eyebrow">MEU VOTO</span><p><strong>{p.myVote.choice}</strong></p><small className="quiet">Fundamentação registrada em {prettyTime(p.myVote.createdAt)}.</small></div>}
        {p.status === 'Aguardando informações' && <form className="panel card-pad action-panel" onSubmit={submitInfo}><span className="eyebrow">INFORMAÇÕES SOLICITADAS</span><h2>Complementar processo</h2><div className="field"><label htmlFor="additional-info">Mensagem</label><textarea id="additional-info" minLength={5} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} required /></div><button className="btn btn-primary full-btn" disabled={infoMutation.isPending || message.length < 5}>Enviar informações</button></form>}
      </aside>
    </div>
  </>;
}

function DecisionsRoute() {
  const decisions = useGetPublishedDecisions();
  return <div className="app"><header className="workspace-head"><div className="wrap"><div className="head-line"><Brand light /><Link className="btn" href="/portal">Acessar portal <ArrowRight size={14} /></Link></div></div></header><main className="wrap public-decisions"><PageTitle eyebrow="TRANSPARÊNCIA PÚBLICA" title="Decisões publicadas" detail="Resultados e resumos dos julgamentos concluídos neste ambiente de roleplay." /><DecisionList data={decisions.data ?? []} loading={decisions.isLoading} error={decisions.isError} retry={() => decisions.refetch()} /><Link href="/" className="back-link"><ArrowLeft size={14} /> Página inicial</Link></main><RPBadge /></div>;
}

function AdminRoute() {
  return <ProfileGate>{(profile) => profile.role === 'ADMINISTRADOR' ? <WorkspaceLayout profile={profile}><AdminPage profile={profile} /></WorkspaceLayout> : <AccessDenied profile={profile} />}</ProfileGate>;
}
function AccessDenied({ profile }: { profile: UserProfile }) {
  return <WorkspaceLayout profile={profile}><div className="panel card-pad denied"><Shield size={24} /><h1 className="serif">Permissão necessária</h1><p>Esta área está disponível apenas para administradores do portal.</p><Link href="/portal" className="btn btn-primary">Voltar ao painel</Link></div></WorkspaceLayout>;
}
type AdminTab = 'overview' | 'users' | 'processes' | 'settings' | 'audit';
type QueryState<T> = {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
};
function AdminPage({ profile }: { profile: UserProfile }) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const dashboard = useGetAdminDashboard();
  const users = useListUsers();
  const ministers = useListMinisters();
  const settings = useGetSystemSettings();
  const audit = useListAuditLogs();
  const processes = useListProcesses(undefined, { query: { queryKey: getListProcessesQueryKey() } });
  const client = useQueryClient();
  const updateRole = useUpdateUserRole();
  const assign = useAssignMinister();
  const updateStatus = useUpdateProcessStatus();
  const startTrial = useStartTrial();
  const publish = usePublishDecision();
  const updateSettings = useUpdateSystemSettings();
  const telegram = useSetTelegramWebhook();
  const [alert, setAlert] = useState(''); const [error, setError] = useState('');
  const [deadline, setDeadline] = useState(''); const [webhook, setWebhook] = useState('');
  const [decisionId, setDecisionId] = useState<number | null>(null); const [decisionText, setDecisionText] = useState('');
  const refreshAdmin = async () => Promise.all([
    client.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() }),
    client.invalidateQueries({ queryKey: getListUsersQueryKey() }),
    client.invalidateQueries({ queryKey: getListMinistersQueryKey() }),
    client.invalidateQueries({ queryKey: getGetSystemSettingsQueryKey() }),
    client.invalidateQueries({ queryKey: getListAuditLogsQueryKey() }),
    client.invalidateQueries({ queryKey: getListProcessesQueryKey() }),
    client.invalidateQueries({ queryKey: getGetPublishedDecisionsQueryKey() }),
  ]);
  async function action(task: () => Promise<unknown>, message: string) {
    setError(''); setAlert('');
    try { await task(); await refreshAdmin(); setAlert(message); }
    catch { setError('A alteração não foi salva. Confira os dados e tente novamente.'); }
  }
  const tabs: Array<[AdminTab, string]> = [['overview', 'Resumo'], ['users', 'Pessoas e assentos'], ['processes', 'Processos'], ['settings', 'Configurações'], ['audit', 'Histórico']];
  return <>
    <PageTitle eyebrow="CONTROLE INSTITUCIONAL" title="Administração" detail={`Sessão administrativa · ${profile.name}`} />
    {error && <div className="error-box">{error}</div>}{alert && <div className="success-box"><Check size={15} />{alert}</div>}
    <div className="admin-tabs" role="tablist">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={cx('admin-tab', tab === key && 'active')} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'overview' && <AdminOverview dashboard={dashboard} audit={audit} />}
    {tab === 'users' && <UsersAdmin users={users} ministers={ministers} updateRole={updateRole} assign={assign} run={action} />}
    {tab === 'processes' && <AdminProcesses processes={processes} updateStatus={updateStatus} startTrial={startTrial} publish={publish} run={action} decisionId={decisionId} setDecisionId={setDecisionId} decisionText={decisionText} setDecisionText={setDecisionText} />}
    {tab === 'settings' && <SettingsAdmin settings={settings} deadline={deadline} setDeadline={setDeadline} webhook={webhook} setWebhook={setWebhook} updateSettings={updateSettings} telegram={telegram} run={action} />}
    {tab === 'audit' && <AuditAdmin audit={audit} />}
  </>;
}
function AdminOverview({ dashboard, audit }: { dashboard: QueryState<AdminDashboard>; audit: QueryState<AuditLog[]> }) {
  if (dashboard.isLoading) return <LoadingRows count={3} />;
  if (dashboard.isError || !dashboard.data) return <ErrorState retry={() => dashboard.refetch()} />;
  const d = dashboard.data;
  return <><div className="stats admin-stats">{[['Total de processos', d.totalProcesses], ['Recebidos', d.received], ['Em análise', d.inReview], ['Em julgamento', d.inJudgment], ['Aguardando informação', d.awaitingInformation], ['Concluídos', d.concluded], ['Assentos ocupados', d.ministersAssigned]].map(([label, value]) => <div className="stat" key={String(label)}><strong>{value}</strong><span>{label}</span></div>)}</div><div className="section-heading" style={{ marginTop: 35 }}><div><span className="eyebrow">AUDITORIA</span><h2>Atividade recente</h2></div></div><AuditList data={audit.data?.slice(0, 6) ?? []} loading={audit.isLoading} error={audit.isError} retry={() => audit.refetch()} /></>;
}
function UsersAdmin({ users, ministers, updateRole, assign, run }: { users: QueryState<AdminUser[]>; ministers: QueryState<AdminUser[]>; updateRole: ReturnType<typeof useUpdateUserRole>; assign: ReturnType<typeof useAssignMinister>; run: (task: () => Promise<unknown>, msg: string) => Promise<void> }) {
  if (users.isLoading || ministers.isLoading) return <LoadingRows />;
  if (users.isError || ministers.isError) return <ErrorView retry={() => { users.refetch(); ministers.refetch(); }} />;
  const all = users.data ?? []; const seats = ministers.data ?? [];
  return <div className="admin-stack"><section><div className="section-heading"><div><span className="eyebrow">COLEGIADO</span><h2>Assentos ministeriais</h2><p>Cada assento é independente e ocupa uma posição no colegiado.</p></div></div><div className="seat-grid">{[1, 2, 3, 4, 5].map((seat) => {
    const member = seats.find((u) => u.ministerSeat === seat);
    return <div className="seat-card" key={seat}><span>ASSENTO {seat}</span><strong>{member?.name ?? 'Vago'}</strong><small>{member?.email ?? 'Sem ministro designado'}</small><select aria-label={`${member ? 'Alterar' : 'Designar'} ministro ao assento ${seat}`} value={member?.id ?? ''} onChange={(e) => { if (e.target.value) void run(() => assign.mutateAsync({ data: { userId: Number(e.target.value), seat } }), `Assento ${seat} atualizado.`); }}><option value="" disabled>Designar pessoa…</option>{all.filter((u) => u.active && u.role !== 'ADMINISTRADOR' && !seats.some((m) => m.id === u.id && m.id !== member?.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>;
  })}</div></section>
    <section><div className="section-heading"><div><span className="eyebrow">CONTAS</span><h2>Usuários registrados</h2><p>Gerencie o perfil de acesso. A remoção de conta não está disponível nesta versão.</p></div></div><div className="panel table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Conta</th><th>Alterar perfil</th></tr></thead><tbody>{all.map((u: AdminUser) => <tr key={u.id}><td><strong>{u.name}</strong></td><td>{u.email ?? 'Conta do Telegram sem e-mail'}</td><td>{roles[u.role] ?? u.role}{u.ministerSeat ? ` · Assento ${u.ministerSeat}` : ''}</td><td><span className={cx('status', u.active ? 'green' : '')}>{u.active ? 'Ativa' : 'Somente Telegram'}</span></td><td><select aria-label={`Alterar perfil de ${u.name}`} value={u.role} disabled={updateRole.isPending || u.role === 'MINISTRO' || !u.active} onChange={(e) => void run(() => updateRole.mutateAsync({ userId: u.id, data: { role: e.target.value as 'ADMINISTRADOR' | 'CIDADÃO' } }), `Perfil de ${u.name} atualizado.`)}><option value="CIDADÃO">Cidadão</option><option value="ADMINISTRADOR">Administrador</option>{u.role === 'MINISTRO' && <option value="MINISTRO">Ministro</option>}</select></td></tr>)}</tbody></table></div></section>
  </div>;
}
function AdminProcesses({ processes, updateStatus, startTrial, publish, run, decisionId, setDecisionId, decisionText, setDecisionText }: { processes: QueryState<ProcessListItem[]>; updateStatus: ReturnType<typeof useUpdateProcessStatus>; startTrial: ReturnType<typeof useStartTrial>; publish: ReturnType<typeof usePublishDecision>; run: (task: () => Promise<unknown>, msg: string) => Promise<void>; decisionId: number | null; setDecisionId: (id: number | null) => void; decisionText: string; setDecisionText: (text: string) => void }) {
  if (processes.isLoading) return <LoadingRows />;
  if (processes.isError) return <ErrorView retry={() => processes.refetch()} />;
  if (!processes.data?.length) return <div className="panel"><EmptyState title="Nenhum processo visível." /></div>;
  return <div className="panel table-wrap"><table><thead><tr><th>Processo</th><th>Assunto</th><th>Status atual</th><th>Prazo</th><th>Ações</th></tr></thead><tbody>{processes.data.map((p) => <tr key={p.id}><td><Link href={`/processos/${p.id}`} className="table-link">{p.processNumber}</Link></td><td>{p.subject}</td><td><StatusPill status={p.status} /></td><td>{prettyDate(p.deadlineAt)}</td><td><div className="row-actions">
    <select aria-label={`Atualizar status de ${p.processNumber}`} value={p.status} onChange={(e) => void run(() => updateStatus.mutateAsync({ processId: p.id, data: { status: e.target.value as ProcessStatus } }), `Status do processo ${p.processNumber} atualizado.`)}>{Object.keys(statusHuman).map((status) => <option key={status} value={status}>{status}</option>)}</select>
    {p.status !== 'Em julgamento' && <button className="mini-action" onClick={() => void run(() => startTrial.mutateAsync({ processId: p.id }), `Julgamento iniciado para ${p.processNumber}.`)}><Gavel size={13} /> Iniciar julgamento</button>}
    {p.status === 'Julgamento concluído' && <button className="mini-action" onClick={() => { setDecisionId(p.id); setDecisionText(''); }}><FileCheck2 size={13} /> Publicar decisão</button>}
  </div></td></tr>)}</tbody></table>
  {decisionId !== null && <div className="modal-scrim" role="presentation"><form className="modal-card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await publish.mutateAsync({ processId: decisionId, data: { summary: decisionText.trim() } }); setDecisionId(null); }, 'Decisão publicada.'); }}><button type="button" className="modal-close" onClick={() => setDecisionId(null)} aria-label="Fechar"><X size={18} /></button><span className="eyebrow">PUBLICAR DECISÃO</span><h2>Resumo público</h2><p>Este texto ficará disponível na lista pública de decisões.</p><textarea value={decisionText} onChange={(e) => setDecisionText(e.target.value)} minLength={20} maxLength={10000} required placeholder="Registre o resumo da decisão colegiada." /><div className="form-actions"><button type="button" className="btn btn-light" onClick={() => setDecisionId(null)}>Cancelar</button><button className="btn btn-primary" disabled={publish.isPending || decisionText.length < 20}>Publicar</button></div></form></div>}
  </div>;
}
function SettingsAdmin({ settings, deadline, setDeadline, webhook, setWebhook, updateSettings, telegram, run }: { settings: QueryState<SystemSettings>; deadline: string; setDeadline: (value: string) => void; webhook: string; setWebhook: (value: string) => void; updateSettings: ReturnType<typeof useUpdateSystemSettings>; telegram: ReturnType<typeof useSetTelegramWebhook>; run: (task: () => Promise<unknown>, msg: string) => Promise<void> }) {
  return <div className="settings-grid"><section className="panel card-pad"><span className="eyebrow">PRAZOS</span><h2>Prazo padrão de julgamento</h2><p className="quiet">Define a quantidade de horas aplicada a novos processos conforme as regras do RP.</p>{settings.isLoading ? <div className="skeleton" /> : settings.isError ? <ErrorView retry={() => settings.refetch()} /> : <form onSubmit={(e) => { e.preventDefault(); const hours = Number(deadline || settings.data?.deadlineHours); void run(() => updateSettings.mutateAsync({ data: { deadlineHours: hours } }), 'Configuração de prazo atualizada.'); }}><div className="field"><label htmlFor="deadline-hours">Horas</label><input type="number" id="deadline-hours" min="1" max="720" value={deadline || settings.data?.deadlineHours || ''} onChange={(e) => setDeadline(e.target.value)} /></div><button className="btn btn-primary" disabled={updateSettings.isPending}>Salvar prazo</button></form>}</section>
    <section className="panel card-pad"><span className="eyebrow">NOTIFICAÇÕES</span><h2>Webhook do Telegram</h2><p className="quiet">Configure um endpoint para as notificações do ambiente. O webhook não altera decisões ou votos.</p><form onSubmit={(e) => { e.preventDefault(); void run(() => telegram.mutateAsync({ data: { webhookUrl: webhook.trim() } }), 'Webhook atualizado.'); }}><div className="field"><label htmlFor="webhook-url">URL do webhook</label><input id="webhook-url" type="url" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://…" required /></div><button className="btn btn-primary" disabled={telegram.isPending || !webhook}>Salvar webhook</button></form></section>
  </div>;
}
function AuditAdmin({ audit }: { audit: QueryState<AuditLog[]> }) {
  return <><div className="section-heading"><div><span className="eyebrow">REGISTRO DE ATIVIDADE</span><h2>Histórico administrativo</h2><p>Ações registradas no sistema, em ordem cronológica.</p></div></div><AuditList data={audit.data ?? []} loading={audit.isLoading} error={audit.isError} retry={() => audit.refetch()} /></>;
}
function AuditList({ data, loading, error, retry }: { data: AuditLog[]; loading: boolean; error: boolean; retry: () => void }) {
  if (loading) return <LoadingRows />;
  if (error) return <ErrorState retry={retry} />;
  if (!data.length) return <div className="panel"><EmptyState title="Nenhum registro de auditoria." /></div>;
  return <div className="panel audit-list">{data.map((row) => <div className="audit-row" key={row.id}><span className="audit-icon"><Activity size={15} /></span><div><strong>{row.action}</strong><p>{row.details}</p><small>{row.actorName} · {prettyTime(row.createdAt)}</small></div></div>)}</div>;
}

function NotFound() {
  return <div className="app not-found"><div className="not-found-content"><Brand /><span className="eyebrow">ERRO 404</span><h1 className="serif">Esta página não consta nos autos.</h1><p>O endereço pode ter mudado ou não estar disponível.</p><Link className="btn btn-primary" href="/">Voltar ao início <ArrowRight size={14} /></Link></div><RPBadge /></div>;
}
function Router() {
  return <Switch>
    <Route path="/" component={PublicHome} />
    <Route path="/sign-in" component={SignInPage} />
    <Route path="/sign-in/:path*" component={SignInPage} />
    <Route path="/sign-up" component={SignUpPage} />
    <Route path="/sign-up/:path*" component={SignUpPage} />
    <Route path="/portal" component={PortalRoute} />
    <Route path="/denuncias/nova" component={ComplaintRoute} />
    <Route path="/processos/:id" component={ProcessRoute} />
    <Route path="/decisoes" component={DecisionsRoute} />
    <Route path="/admin" component={AdminRoute} />
    <Route component={NotFound} />
  </Switch>;
}
function ClerkRouter({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkKey}
    signInUrl="/sign-in"
    signUpUrl="/sign-up"
    signInFallbackRedirectUrl="/portal"
    signUpFallbackRedirectUrl="/portal"
    routerPush={(to: string) => setLocation(to)}
    routerReplace={(to: string) => setLocation(to)}
  >{children}</ClerkProvider>;
}
function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><ClerkRouter><Router /></ClerkRouter></WouterRouter></QueryClientProvider>;
}
export default App;