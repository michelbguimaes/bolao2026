/**
 * RECEPTOR BLINDADO - BOLÃO LOTOFÁCIL DA INDEPENDÊNCIA 2026
 * - Proteção Anti-Spam / Anti-Flood via CacheService
 * - Validação de Token de Sessão Dinâmico
 * - LockService Concorrente (15s)
 * - Transbordo e Reserva do Organizador
 */

// Chave interna para gerar tokens temporários
const SEGREDO_SISTEMA = "LotofacilIndependencia_Segredo_2026";

function gerarTokenSessao() {
  const agora = Math.floor(Date.now() / (1000 * 60 * 30)); // Válido por ciclos de 30 minutos
  const bruto = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SEGREDO_SISTEMA + agora);
  return Utilities.base64Encode(bruto).substring(0, 16);
}

function validarTokenSessao(tokenRecebido) {
  const agora = Math.floor(Date.now() / (1000 * 60 * 30));
  const tokenAtual = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SEGREDO_SISTEMA + agora)
  ).substring(0, 16);

  const anterior = agora - 1;
  const tokenAnterior = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SEGREDO_SISTEMA + anterior)
  ).substring(0, 16);

  return tokenRecebido === tokenAtual || tokenRecebido === tokenAnterior;
}

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetConfig = ss.getSheetByName("Config");

    // 1. VALIDAÇÃO REMOTA DE SENHA MESTRE
    if (e && e.parameter && e.parameter.acao === "validarSenha") {
      let senhaReal = "2026";
      if (sheetConfig) {
        senhaReal = String(sheetConfig.getRange("B1").getValue()).trim();
      }
      const senhaInformada = String(e.parameter.senha || "").trim();
      return ContentService
        .createTextOutput(JSON.stringify({ autorizada: (senhaInformada === senhaReal) }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. CONSULTA DE VAGAS EM TEMPO REAL
    const LIMITE = 30;

    function obterUltimaCota(nomeAba) {
      const sheet = ss.getSheetByName(nomeAba);
      if (!sheet) return 0;
      const total = sheet.getLastRow();
      if (total <= 1) return 0;
      const ultimosDados = sheet.getRange(total, 2).getValue();
      const match = String(ultimosDados).match(/\d+/);
      return match ? parseInt(match[0], 10) : 0;
    }

    let numGrupos = 2;
    if (sheetConfig) {
      const valB5 = parseInt(sheetConfig.getRange("B5").getValue(), 10);
      if (!isNaN(valB5) && valB5 > 0) {
        numGrupos = valB5;
      }
    }

    const grupos = [];
    let vagasA = 0;
    let vagasB = 0;
    let grupoAtivo = "Lotado";

    for (let i = 0; i < numGrupos; i++) {
      const nomeGrupo = "Grupo " + String.fromCharCode(65 + i);
      const cota = obterUltimaCota(nomeGrupo);
      const vagas = Math.max(0, LIMITE - cota);
      
      grupos.push({
        nome: nomeGrupo,
        vagas: vagas
      });

      if (i === 0) vagasA = vagas;
      if (i === 1) vagasB = vagas;

      if (grupoAtivo === "Lotado" && vagas > 0) {
        grupoAtivo = nomeGrupo;
      }
    }

    // 3. LEITURA DOS DADOS INSTITUCIONAIS
    let chavePix = "Consulte o organizador";
    let titularPix = "Organizador do Bolão";
    let whatsApp = "5531987520694";

    if (sheetConfig) {
      chavePix = String(sheetConfig.getRange("B2").getValue()).trim() || chavePix;
      titularPix = String(sheetConfig.getRange("B3").getValue()).trim() || titularPix;
      whatsApp = String(sheetConfig.getRange("B4").getValue()).replace(/\D/g, "") || whatsApp;
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        status: "sucesso",
        vagasA: vagasA,
        vagasB: vagasB,
        grupoAtivo: grupoAtivo,
        grupos: grupos,
        tokenSessao: gerarTokenSessao(), // Envia o token legítimo para a página
        config: {
          pixChave: chavePix,
          pixTitular: titularPix,
          whatsapp: whatsApp
        }
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (erro) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "erro", mensagem: erro.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  // 1. BLOQUEIO DE CONCORRÊNCIA EXCLUSIVO (15 SEGUNDOS)
  const lock = LockService.getScriptLock();
  const obteveLock = lock.tryLock(15000);

  if (!obteveLock) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "erro", msg: "Servidor ocupado. Tente novamente." }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const payload = JSON.parse(e.postData.contents);

    // 2. PROTEÇÃO ANTI-BOT: VALIDAÇÃO DO TOKEN DE SESSÃO
    if (!payload.token || !validarTokenSessao(payload.token)) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: "erro", msg: "Acesso não autorizado ou token expirado." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const nome = String(payload.nome || "").trim();
    const telefone = String(payload.telefone || "").replace(/\D/g, "");
    const cotasTotal = parseInt(payload.cotas, 10) || 1;
    const dividirGrupos = !!payload.dividirGrupos;
    const listaJogos = payload.jogos || [];

    // Validação mínima de payload
    if (nome.length < 3 || telefone.length < 10 || listaJogos.length !== cotasTotal * 4) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: "erro", msg: "Dados incompletos ou inconsistentes." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. RATE LIMITING: IMPEDE MESMO TELEFONE DE DISPARAR EM MENOS DE 60s
    const cache = CacheService.getScriptCache();
    const chaveCacheTelefone = "flood_" + telefone;
    if (cache.get(chaveCacheTelefone)) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: "erro", msg: "Requisição recente detectada. Aguarde 1 minuto." }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // Grava bloqueio de 60 segundos para este telefone
    cache.put(chaveCacheTelefone, "bloqueado", 60);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const LIMITE_COTAS_POR_GRUPO = 30;
    const sheetConfig = ss.getSheetByName("Config");

    let numGrupos = 2;
    if (sheetConfig) {
      const valB5 = parseInt(sheetConfig.getRange("B5").getValue(), 10);
      if (!isNaN(valB5) && valB5 > 0) {
        numGrupos = valB5;
      }
    }
    const gruposValidos = [];
    for (let i = 0; i < numGrupos; i++) {
      gruposValidos.push("Grupo " + String.fromCharCode(65 + i));
    }

    function obterOuCriarAbaComAdmin(nomeAba) {
      let sheet = ss.getSheetByName(nomeAba);
      if (!sheet) {
        sheet = ss.insertSheet(nomeAba);
      }
      if (sheet.getLastRow() < 9) {
        sheet.clear();
        const cabecalho = [
          "Nº Jogo (1-120)",
          "Nº da Cota (1-30)",
          "Nome Participante",
          "WhatsApp",
          "Dezenas Formatadas",
          "Data/Hora Registro",
          "Status Pagamento (PIX)"
        ];
        sheet.appendRow(cabecalho);
        sheet.getRange("A1:G1").setFontWeight("bold").setBackground("#e2e8f0");

        const timestampAdmin = Utilities.formatDate(new Date(), "America/Sao_Paulo", "dd/MM/yyyy HH:mm:ss");
        const linhasAdmin = [
          [1, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [2, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [3, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [4, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [5, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [6, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [7, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
          [8, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"]
        ];
        sheet.getRange(2, 1, linhasAdmin.length, 7).setValues(linhasAdmin);
      }
      return sheet;
    }

    function obterContadores(sheet) {
      const totalLinhas = sheet.getLastRow();
      let ultimoJogo = 0;
      let ultimaCota = 0;

      if (totalLinhas > 1) {
        const ultimosDados = sheet.getRange(totalLinhas, 1, 1, 2).getValues()[0];
        ultimoJogo = parseInt(ultimosDados[0], 10) || 0;
        const matchCota = String(ultimosDados[1]).match(/\d+/);
        ultimaCota = matchCota ? parseInt(matchCota[0], 10) : 0;
      }
      return { ultimoJogo, ultimaCota };
    }

    function registrarJogosNaAba(sheet, jogosDoGrupo) {
      if (jogosDoGrupo.length === 0) return;

      const { ultimoJogo, ultimaCota } = obterContadores(sheet);
      const timestamp = Utilities.formatDate(new Date(), "America/Sao_Paulo", "dd/MM/yyyy HH:mm:ss");
      const novasLinhas = [];

      let cotaBase = ultimaCota + 1;
      let jogoBase = ultimoJogo + 1;

      for (let i = 0; i < jogosDoGrupo.length; i++) {
        const cotaAtual = cotaBase + Math.floor(i / 4);
        let labelCota = "Cota " + (cotaAtual < 10 ? "0" + cotaAtual : cotaAtual);

        novasLinhas.push([
          jogoBase + i,
          labelCota,
          nome,
          payload.telefone,
          jogosDoGrupo[i],
          timestamp,
          "Pendente (Aguardando PIX)"
        ]);
      }

      sheet.getRange(sheet.getLastRow() + 1, 1, novasLinhas.length, 7).setValues(novasLinhas);
    }

    let alocacoesParaProcessar = [];

    // 4. VERIFICAÇÃO DE ALOCAÇÃO
    if (payload.alocacao && Array.isArray(payload.alocacao) && payload.alocacao.length > 0) {
      // Nova versão com suporte a múltiplos grupos
      let somaCotas = 0;
      for (const aloc of payload.alocacao) {
        if (!gruposValidos.includes(aloc.grupo)) {
          return ContentService
            .createTextOutput(JSON.stringify({ status: "erro", msg: "Grupo inválido solicitado: " + aloc.grupo }))
            .setMimeType(ContentService.MimeType.JSON);
        }
        somaCotas += parseInt(aloc.cotas, 10);
      }
      
      if (somaCotas !== cotasTotal) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: "erro", msg: "Soma de cotas na alocação não confere com total." }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      // Validar vagas antes de processar
      for (const aloc of payload.alocacao) {
        const sheetGrupo = obterOuCriarAbaComAdmin(aloc.grupo);
        const { ultimaCota } = obterContadores(sheetGrupo);
        const vagas = Math.max(0, LIMITE_COTAS_POR_GRUPO - ultimaCota);
        if (vagas < aloc.cotas) {
           return ContentService
            .createTextOutput(JSON.stringify({ status: "erro", msg: "Vagas insuficientes no " + aloc.grupo + ". Vagas disponíveis: " + vagas }))
            .setMimeType(ContentService.MimeType.JSON);
        }
        alocacoesParaProcessar.push({ sheet: sheetGrupo, cotas: parseInt(aloc.cotas, 10) });
      }

    } else {
      // Backward compatibility com a versão anterior (somente Grupo A e B)
      const sheetA = obterOuCriarAbaComAdmin("Grupo A");
      const sheetB = obterOuCriarAbaComAdmin("Grupo B");

      const contadoresA = obterContadores(sheetA);
      const contadoresB = obterContadores(sheetB);

      const vagasA = Math.max(0, LIMITE_COTAS_POR_GRUPO - contadoresA.ultimaCota);
      const vagasB = Math.max(0, LIMITE_COTAS_POR_GRUPO - contadoresB.ultimaCota);

      // 4. TRAVA DE CAPACIDADE TOTAL: SE NÃO HOUVER VAGAS, REJEITA
      if (vagasA === 0 && vagasB === 0) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: "erro", msg: "Bolão esgotado! Todas as cotas foram preenchidas." }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      let alocadasA = 0;
      let alocadasB = 0;

      if (!dividirGrupos || cotasTotal === 1) {
        if (vagasA >= cotasTotal) {
          alocadasA = cotasTotal;
        } else if (vagasA > 0) {
          alocadasA = vagasA;
          alocadasB = cotasTotal - vagasA;
        } else {
          alocadasB = cotasTotal;
        }
      } else {
        let planejadoA = 1;
        if (cotasTotal === 3 || cotasTotal === 4) planejadoA = 2;

        if (vagasA >= planejadoA) {
          alocadasA = planejadoA;
          alocadasB = cotasTotal - planejadoA;
        } else {
          alocadasA = vagasA;
          alocadasB = cotasTotal - vagasA;
        }
      }

      // Se o pedido exceder as vagas totais restantes, trunca para o limite
      if (alocadasB > vagasB) alocadasB = vagasB;

      if (alocadasA > 0) alocacoesParaProcessar.push({ sheet: sheetA, cotas: alocadasA });
      if (alocadasB > 0) alocacoesParaProcessar.push({ sheet: sheetB, cotas: alocadasB });
    }

    // Processar gravações
    let indexJogo = 0;
    for (const aloc of alocacoesParaProcessar) {
      const qtdJogos = aloc.cotas * 4;
      const jogosDoGrupo = listaJogos.slice(indexJogo, indexJogo + qtdJogos);
      registrarJogosNaAba(aloc.sheet, jogosDoGrupo);
      indexJogo += qtdJogos;
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "sucesso" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (erro) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "erro", mensagem: erro.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function onEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (range.getColumn() !== 7 || range.getRow() === 1) return;

  const novoStatus = e.value;
  if (!novoStatus) return;

  const linhaAlterada = range.getRow();
  const cotaAlterada = sheet.getRange(linhaAlterada, 2).getValue();
  if (!cotaAlterada) return;

  const ultimaLinha = sheet.getLastRow();
  const cotasColuna = sheet.getRange(2, 2, ultimaLinha - 1, 1).getValues();

  for (let i = 0; i < cotasColuna.length; i++) {
    if (cotasColuna[i][0] === cotaAlterada) {
      sheet.getRange(i + 2, 7).setValue(novoStatus);
    }
  }
}

function resetarEPopularAdmin() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetConfig = ss.getSheetByName("Config");

  let numGrupos = 2;
  if (sheetConfig) {
    const valB5 = parseInt(sheetConfig.getRange("B5").getValue(), 10);
    if (!isNaN(valB5) && valB5 > 0) {
      numGrupos = valB5;
    }
  }

  const grupos = [];
  for (let i = 0; i < numGrupos; i++) {
    grupos.push("Grupo " + String.fromCharCode(65 + i));
  }
  
  grupos.forEach(nomeAba => {
    let sheet = ss.getSheetByName(nomeAba);
    if (!sheet) {
      sheet = ss.insertSheet(nomeAba);
    } else {
      sheet.clear();
    }

    const cabecalho = [
      "Nº Jogo (1-120)",
      "Nº da Cota (1-30)",
      "Nome Participante",
      "WhatsApp",
      "Dezenas Formatadas",
      "Data/Hora Registro",
      "Status Pagamento (PIX)"
    ];
    sheet.appendRow(cabecalho);
    sheet.getRange("A1:G1").setFontWeight("bold").setBackground("#e2e8f0");

    const timestampAdmin = Utilities.formatDate(new Date(), "America/Sao_Paulo", "dd/MM/yyyy HH:mm:ss");
    const linhasAdmin = [
      [1, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [2, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [3, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [4, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [5, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [6, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [7, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [8, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"]
    ];
    sheet.getRange(2, 1, linhasAdmin.length, 7).setValues(linhasAdmin);
  });
}

function criarNovosGruposFaltantes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetConfig = ss.getSheetByName("Config");

  let numGrupos = 2;
  if (sheetConfig) {
    const valB5 = parseInt(sheetConfig.getRange("B5").getValue(), 10);
    if (!isNaN(valB5) && valB5 > 0) {
      numGrupos = valB5;
    }
  }

  const grupos = [];
  for (let i = 0; i < numGrupos; i++) {
    grupos.push("Grupo " + String.fromCharCode(65 + i));
  }
  
  grupos.forEach(nomeAba => {
    let sheet = ss.getSheetByName(nomeAba);
    // Se a aba JÁ EXISTE, não fazemos nada! Assim preservamos os dados de quem já jogou.
    if (sheet) {
      return; 
    }
    
    // Se não existe, criamos a aba novinha e populamos com o admin
    sheet = ss.insertSheet(nomeAba);

    const cabecalho = [
      "Nº Jogo (1-120)",
      "Nº da Cota (1-30)",
      "Nome Participante",
      "WhatsApp",
      "Dezenas Formatadas",
      "Data/Hora Registro",
      "Status Pagamento (PIX)"
    ];
    sheet.appendRow(cabecalho);
    sheet.getRange("A1:G1").setFontWeight("bold").setBackground("#e2e8f0");

    const timestampAdmin = Utilities.formatDate(new Date(), "America/Sao_Paulo", "dd/MM/yyyy HH:mm:ss");
    const linhasAdmin = [
      [1, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [2, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [3, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [4, "Cota 01", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [5, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [6, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [7, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"],
      [8, "Cota 02", "Michel Guimarães", "(31) 98752-0694", "", timestampAdmin, "Confirmado (Organizador)"]
    ];
    sheet.getRange(2, 1, linhasAdmin.length, 7).setValues(linhasAdmin);
  });
}
