import { readFile, writeFile, rename } from 'node:fs/promises';

const arquivo = new URL('./painel.json', import.meta.url);
const painel = JSON.parse(await readFile(arquivo, 'utf8'));
const codigoCargo = { 'Governador(a)': 3, 'Vice-governador(a)': 3, 'Senador(a)': 5, 'Deputado(a) Federal': 6, 'Deputado(a) Estadual': 7, 'Deputado(a) Distrital': 8 };
const nomeCargo = { 3: 'Governador(a)', 5: 'Senador(a)', 6: 'Deputado(a) Federal', 7: 'Deputado(a) Estadual', 8: 'Deputado(a) Distrital' };
const url = (uf, codigo) => `https://resultados.tse.jus.br/oficial/ele2026/6259/dados/${uf}/${uf}-c${String(codigo).padStart(4, '0')}-e006259-u.json`;
const chave = (uf, cargo, numero, tipo = 'TITULAR') => `${uf}|${cargo}|${numero}|${tipo}`;
const agora = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(',', '');
const normalizar = (status, tipo, ea) => {
  const s = String(status || '').trim().toUpperCase();
  const mapa = { 'ELEITO': 'ELEITO', 'ELEITA': 'ELEITO', 'ELEITO POR QP': 'ELEITO', 'ELEITO POR MÉDIA': 'ELEITO', '2º TURNO': 'SEGUNDO_TURNO', 'SEGUNDO TURNO': 'SEGUNDO_TURNO', 'NÃO ELEITO': 'NAO_ELEITO', 'NAO ELEITO': 'NAO_ELEITO', 'EM APURAÇÃO': 'EM_APURACAO', 'EM APURACAO': 'EM_APURACAO', 'AGUARDANDO': 'AGUARDANDO_DADOS', 'FORA DA URNA': 'FORA_DA_URNA' };
  let r = mapa[s] || (ea.tf === 's' ? (ea.e === 's' ? 'ELEITO' : 'NAO_ELEITO') : ea.and === 'n' ? 'AGUARDANDO_DADOS' : 'EM_APURACAO');
  if (tipo === 'SUPLENTE_SENADO' && r === 'ELEITO') r = 'SUPLENTE';
  return r;
};
const rotulo = s => ({ ELEITO: 'Eleito(a)', SEGUNDO_TURNO: '2º turno', SUPLENTE: 'Suplente — chapa eleita', NAO_ELEITO: 'Não eleito(a)', EM_APURACAO: 'Em apuração', AGUARDANDO_DADOS: 'Aguardando dados', FORA_DA_URNA: 'Fora da urna' })[s] || 'Em revisão';

const fontes = [...new Map(painel.candidaturas.map(c => {
  const codigo = codigoCargo[c.cargo];
  if (!codigo || !c.numero) throw new Error(`Base incompleta: ${c.nome_exibicao}`);
  return [`${c.uf}|${codigo}`, { uf: c.uf.toLowerCase(), codigo }];
})).values()];
const baixados = await Promise.all(fontes.map(async f => {
  const r = await fetch(url(f.uf, f.codigo), { signal: AbortSignal.timeout(25000), headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${f.uf.toUpperCase()}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.f !== 'o' || j.tpabr !== 'uf' || !Array.isArray(j.carg)) throw new Error(`${f.uf.toUpperCase()}: arquivo oficial inválido`);
  return { ...f, j };
}));

const registros = new Map();
for (const { uf, codigo, j } of baixados) {
  const cargo = nomeCargo[codigo];
  const pct = Number(j.s?.pstn ?? j.s?.pst ?? 0);
  for (const agrupamento of j.carg[0].agr || []) for (const partido of agrupamento.par || []) for (const cand of partido.cand || []) {
    const base = { status: cand.st, ea: { tf: j.tf, and: j.and, e: cand.e }, votos: Number(cand.vap || 0), percentual: Number(cand.pvapn ?? cand.pvap ?? 0), totalizacao: pct, chapa: cand.nmu || null, url: url(uf, codigo) };
    registros.set(chave(uf.toUpperCase(), cargo, String(cand.n)), base);
    for (const membro of cand.vs || []) {
      const tipo = membro.tp === 'v' ? 'VICE' : membro.tp === 's1' ? 'SUPLENTE_SENADO' : null;
      if (tipo) registros.set(chave(uf.toUpperCase(), cargo, String(cand.n), tipo), base);
      if (tipo === 'VICE') registros.set(chave(uf.toUpperCase(), 'Vice-governador(a)', String(cand.n), tipo), base);
    }
  }
}
const ausentes = painel.candidaturas.filter(c => !registros.has(chave(c.uf, c.cargo, String(c.numero), c.tipo_participacao)));
if (ausentes.length) throw new Error(`Pareamento interrompido: ${ausentes.length} candidatura(s) não encontrada(s). Nenhum dado foi publicado.`);
const momento = agora();
painel.candidaturas = painel.candidaturas.map(c => {
  const r = registros.get(chave(c.uf, c.cargo, String(c.numero), c.tipo_participacao));
  const status = normalizar(r.status, c.tipo_participacao, r.ea);
  return { ...c, status, rotulo_status: rotulo(status), votos_nominais: r.votos, pct_votos_validos: r.percentual, pct_secoes_totalizadas: r.totalizacao, grau_certeza: ['ELEITO', 'SUPLENTE', 'NAO_ELEITO', 'FORA_DA_URNA'].includes(status) ? 'CONFIRMADO' : 'PARCIAL', chapa_titular: c.tipo_participacao === 'TITULAR' ? null : r.chapa, url_conferencia: r.url, atualizado_em: momento };
});
const porStatus = Object.fromEntries([...new Set(painel.candidaturas.map(c => c.status))].map(s => [s, painel.candidaturas.filter(c => c.status === s).length]));
Object.assign(painel, { gerado_em: momento, fase: 'APURACAO_1T', fonte: 'Justiça Eleitoral (TSE) — EA20 oficial', situacao_sistema: 'OK', ultima_atualizacao_ok: momento, ufs_indisponiveis: [], resumo: { monitoradas: painel.candidaturas.length, na_urna: painel.candidaturas.filter(c => c.status !== 'FORA_DA_URNA').length, por_status: porStatus, totalizacao_por_cargo_uf: [] } });
const temporario = new URL('./painel.json.tmp', import.meta.url);
await writeFile(temporario, `${JSON.stringify(painel, null, 2)}\n`);
await rename(temporario, arquivo);

const webhook = process.env.SLACK_WEBHOOK_URL;
const arquivoAlertas = new URL('./alertas-slack-enviados.json', import.meta.url);
if (!webhook) {
  console.log('Slack não configurado; atualização publicada sem alertas.');
} else if (!webhook.startsWith('https://hooks.slack.com/')) {
  console.error('Slack não configurado: URL de webhook inválida.');
} else {
  let enviados = [];
  try {
    const controle = JSON.parse(await readFile(arquivoAlertas, 'utf8'));
    if (Array.isArray(controle.enviados)) enviados = controle.enviados;
  } catch (erro) {
    if (erro.code !== 'ENOENT') console.error('Não foi possível ler o histórico de alertas do Slack.', erro);
  }
  const idsEnviados = new Set(enviados.map(item => item.id));
  for (const c of painel.candidaturas.filter(c => c.status === 'ELEITO' && !idsEnviados.has(c.id))) {
    const mensagem = ['🟣 *Pessoa LGBTQIA+ eleita*', `*${c.nome_exibicao}* (${c.partido}–${c.uf}) foi marcada como eleita pela Justiça Eleitoral.`, `Cargo: ${c.cargo}`].join('\n');
    try {
      const resposta = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: mensagem }) });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      enviados.push({ id: c.id, nome: c.nome_exibicao, enviado_em: momento });
      await writeFile(arquivoAlertas, `${JSON.stringify({ versao: 1, enviados }, null, 2)}\n`);
      idsEnviados.add(c.id);
      console.log(`Alerta enviado: ${c.nome_exibicao}`);
    } catch (erro) {
      console.error(`Falha ao enviar alerta de ${c.nome_exibicao}. Será tentado novamente na próxima atualização.`, erro);
    }
  }
}
