import json
import time
import requests
import os
import google.generativeai as genai

# --- CONFIGURAÇÕES ---
# Pegamos a chave do ambiente para segurança, ou você pode colar a sua aqui
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "AIzaSyAlAnxLn5GzVNrj0BPqHZVP9ksnZ56iB84")
SERPER_KEY = "f7442270fb6dc29ed74c20bd2f2bb55a1a63e4df"

# Inicializa o Gemini
genai.configure(api_key=GEMINI_KEY)
model = genai.GenerativeModel('gemini-1.5-flash') # Versão rápida e eficiente

def analisar_com_ia(titulo, descricao):
    """
    Pergunta ao Gemini qual a categoria e o nível de alerta do link encontrado.
    """
    prompt = f"""
    Como um analista de mercado solar, analise este resultado de busca:
    Título: {titulo}
    Texto: {descricao}

    Responda EXCLUSIVAMENTE em formato JSON (sem markdown):
    {{
        "categoria": "Reclamação" ou "Oportunidade" ou "Preços" ou "Informativo",
        "justificativa": "breve explicação de 10 palavras",
        "impacto": "Alto", "Médio" ou "Baixo"
    }}
    """
    try:
        response = model.generate_content(prompt)
        # Limpa o texto da resposta para garantir que seja um JSON válido
        txt = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(txt)
    except Exception as e:
        print(f"Erro na IA: {e}")
        return {
            "categoria": "Informativo",
            "justificativa": "Não foi possível analisar via IA",
            "impacto": "Baixo"
        }

def realizar_fluxo_total():
    """
    Busca no Serper -> Analisa com Gemini -> Retorna lista final
    """
    url_serper = "https://google.serper.dev/search"
    termos = [
        'energia solar Porto Seguro reclamações',
        'melhor empresa energia solar Porto Seguro',
        'preço placa solar Porto Seguro 2026'
    ]
    
    headers_serper = {
        'X-API-KEY': SERPER_KEY,
        'Content-Type': 'application/json'
    }

    resultados_enriquecidos = []

    print("🚀 Iniciando monitoramento inteligente...")

    for termo in termos:
        print(f"🔍 Buscando insights para: {termo}")
        payload = json.dumps({
            "q": termo,
            "gl": "br",
            "hl": "pt-br",
            "num": 5
        })
        
        try:
            response = requests.post(url_serper, headers=headers_serper, data=payload, timeout=15)
            links = response.json().get("organic", [])

            for link in links:
                print(f"   🧠 Analisando: {link.get('title')[:40]}...")
                
                # Chamada para a IA analisar o conteúdo
                analise = analisar_com_ia(link.get('title'), link.get('snippet'))
                
                item = {
                    "termo_origem": termo,
                    "titulo": link.get('title'),
                    "link": link.get('link'),
                    "descricao": link.get('snippet'),
                    "data_coleta": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "categoria": analise.get('categoria'),
                    "justificativa": analise.get('justificativa'),
                    "impacto": analise.get('impacto')
                }
                resultados_enriquecidos.append(item)
                
                # Pequeno delay para respeitar limites de cota da IA
                time.sleep(0.5)

        except Exception as e:
            print(f"Erro no termo {termo}: {e}")

    return resultados_enriquecidos

def salvar_dados(dados):
    try:
        with open('dados_solar_ps.json', 'w', encoding='utf-8') as f:
            json.dump(dados, f, indent=4, ensure_ascii=False)
        print(f"✅ Sucesso! {len(dados)} itens salvos no banco local.")
    except Exception as e:
        print(f"Erro ao salvar: {e}")

if __name__ == "__main__":
    novos_dados = realizar_fluxo_total()
    if novos_dados:
        salvar_dados(novos_dados)
