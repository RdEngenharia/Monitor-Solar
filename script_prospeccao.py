import os
import json
import requests
import datetime
import google.generativeai as genai
from google.cloud import firestore

# Configurações via Variáveis de Ambiente (Configurar na Vercel/Cloud)
api_key_gemini = os.getenv("GEMINI_API_KEY")
api_key_serper = os.getenv("serper") 
PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID")
PUSHBULLET_TOKEN = os.getenv("PUSHBULLET_TOKEN")

# Inicializa Google AI (Gemini)
genai.configure(api_key=api_key_gemini)
model = genai.GenerativeModel('gemini-1.5-flash')

# Inicializa Firestore (Nuvem)
db = firestore.Client(project=PROJECT_ID)

def enviar_push(titulo, corpo):
    if not PUSHBULLET_TOKEN:
        return
    try:
        url = "https://api.pushbullet.com/v2/pushes"
        data = {
            "type": "note",
            "title": titulo,
            "body": corpo
        }
        headers = {
            "Access-Token": PUSHBULLET_TOKEN,
            "Content-Type": "application/json"
        }
        requests.post(url, json=data, headers=headers)
        print("[Pushbullet] Notificação enviada.")
    except Exception as e:
        print(f"[Pushbullet] Erro: {e}")

def prospeccao_rd_engenharia(request):
    """
    Função principal configurada para Vercel Cron Jobs.
    Gera buscas em toda a Bahia e notifica leads URGENTES.
    """
    if not api_key_serper or not api_key_gemini:
        return "Erro: Chaves de API não configuradas.", 500

    # Frases de Intenção de Compra (Expansão Bahia)
    termos = [
        'site:facebook.com "alguém indica" "engenheiro" "Coelba"',
        'site:facebook.com "quem faz" "homologação" "solar" "Bahia"',
        'site:facebook.com "preciso aumentar a carga" "padrão"',
        'site:instagram.com "alguém conhece" "engenheiro" "elétrico" "Bahia"',
        'site:facebook.com "alteração de rateio" "energia solar" "ajuda"'
    ]

    leads_contagem = 0

    for query in termos:
        # 1. Busca via Serper (Filtro 30 dias: qdr:m)
        url = "https://google.serper.dev/search"
        payload = json.dumps({
            "q": query,
            "tbs": "qdr:m",
            "gl": "br",
            "hl": "pt-br"
        })
        headers = {
            'X-API-KEY': api_key_serper,
            'Content-Type': 'application/json'
        }
        
        try:
            response = requests.request("POST", url, headers=headers, data=payload)
            search_results = response.json().get('organic', [])
        except Exception as e:
            print(f"Erro Serper: {e}")
            continue

        for item in search_results:
            titulo = item.get('title', '')
            snippet = item.get('snippet', '')
            link = item.get('link', '')

            # 2. Processamento com IA (Gemini) - REGRAS FILTRAGEM RD ENGENHARIA
            prompt = f"""
            Você é um Engenheiro de Dados Sênior especialista em prospecção técnica para a RD Engenharia (Bahia).
            Validar se este post é um LEAD QUENTE ou RUÍDO.

            Texto: {titulo} - {snippet}
            
            CRITÉRIOS DE FILTRAGEM (RD ENGENHARIA):
            1. REGRAS DE EXCLUSÃO (RETORNE RUÍDO):
               - Marketing, propaganda de concorrentes ou agradecimentos.
               - Posts de instaladores solares vendendo kits.
            
            2. REGRAS DE APROVAÇÃO:
               - Pedidos diretos de indicação ("Alguém conhece um engenheiro?").
               - Dúvidas sobre HOMOLOGAÇÃO COELBA, RATEIO ou AUMENTO DE CARGA.
            
            3. GEOGRAFIA: Identifique a CIDADE na Bahia.

            Responda EXCLUSIVAMENTE em JSON:
            {{
                "status": "URGENTE" | "NORMAL" | "RUÍDO",
                "categoria": "Oportunidade" | "Homologação" | "Coelba" | "Infraestrutura",
                "localizacao": "Cidade",
                "motivo": "justificativa técnica"
            }}
            """
            
            try:
                ai_response = model.generate_content(prompt)
                res_cleaned = ai_response.text.strip().replace("```json", "").replace("```", "")
                analise = json.loads(res_cleaned)
                
                if analise.get('status') != "RUÍDO":
                    lead_data = {
                        "termo_origem": query,
                        "titulo": titulo,
                        "link": link,
                        "descricao": snippet,
                        "categoria": analise.get('categoria', 'Oportunidade'),
                        "status_prioridade": analise.get('status'),
                        "localizacao": analise.get('localizacao', 'Bahia (Geral)'),
                        "justificativa": analise.get('motivo'),
                        "impacto": "Alto" if analise.get('status') == "URGENTE" else "Médio",
                        "data_coleta": datetime.datetime.now().strftime("%d/%m/%Y, %H:%M:%S"),
                        "timestamp": datetime.datetime.now().isoformat()
                    }
                    
                    # 3. Salvar no Firebase (Firestore)
                    doc_id = "".join(filter(str.isalnum, link))[:128]
                    db.collection("solar_mentions").document(doc_id).set(lead_data, merge=True)
                    leads_contagem += 1

                    # 4. Notificação PUSHBULLET (Alerta no Celular)
                    enviar_push(
                        "🚨 NOVO LEAD - RD ENGENHARIA",
                        f"📍 {lead_data['localizacao']}\n📝 {titulo}\n💡 {lead_data['justificativa']}"
                    )
                    
            except Exception as e:
                print(f"Erro processando lead: {e}")

    return {
        "status": "sucesso",
        "novos_leads": leads_contagem,
        "mensagem": f"Prospecção Bahia concluída. {leads_contagem} leads salvos."
    }, 200
