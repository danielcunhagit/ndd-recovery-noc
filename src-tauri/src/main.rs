// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose, Engine as _};
use calamine::{open_workbook, Reader, Xlsx};
use chrono::{NaiveDateTime, Utc};
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use reqwest::Client;
use rusqlite::{params, Connection};
use rust_xlsxwriter::{Format, Workbook};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, Semaphore};

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

#[derive(serde::Serialize)]
struct FilteringStats {
    initial_printers: usize,
    initial_companies: usize,
    drop_disabled_printers: usize,
    drop_disabled_companies: usize,
    drop_brand_printers: usize,
    drop_brand_companies: usize,
    flag_2001: usize,
    flag_sporadic: usize,
    matched_sqlite: usize,
    final_printers: usize,
    final_companies: usize,
}

#[derive(serde::Serialize)]
struct NddResult {
    report: String,
    data: Vec<serde_json::Value>,
    stats: FilteringStats,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Contact {
    id: Option<i32>,
    enterprise_name: String,
    tel: String,
    email1: String,
    email2: String,
    email3: String,
    nome1: String,
    nome2: String,
    nome3: String,
    consultor: String,
    codigo_empresa: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct UserProfile {
    email: String,
    name: String,
    title: String,
    department: String,
    phone: String,
}

// --- MÓDULO DE AUTENTICAÇÃO ---
pub struct AuthManager;
impl AuthManager {
    pub fn encrypt_password(password: &str) -> String {
        let key = b"G!P@4#1$1%M4SC4D";
        let iv = b"C#&UjO){QwzFcsPs";
        let pt = password.as_bytes();
        let ct = Aes128CbcEnc::new(key.into(), iv.into()).encrypt_padded_vec_mut::<Pkcs7>(pt);
        general_purpose::STANDARD.encode(ct)
    }
}

#[tauri::command]
async fn handle_login(provider: String, email: String, password: String) -> Result<String, String> {
    let encrypted_password = AuthManager::encrypt_password(&password);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|_| "Erro interno de rede.".to_string())?;

    let body_enterprises = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body><GetEnterprises xmlns="nddprint.com/api/"><properties>{{
                "DealerName":"{}", "DealerUserEmail":"{}", "DealerUserPassword":"{}", "FieldsList":"EnterpriseID"
            }}</properties></GetEnterprises></soap:Body>
        </soap:Envelope>"#,
        provider, email, encrypted_password
    );

    let res = client
        .post("https://api-general.nddprint.com/GeneralWS/GeneralData2.asmx")
        .header("Content-Type", "text/xml; charset=utf-8")
        .body(body_enterprises)
        .send()
        .await
        .map_err(|_| {
            "Falha ao conectar aos servidores da NDD. Verifique sua internet.".to_string()
        })?;

    let xml_response = res
        .text()
        .await
        .map_err(|_| "Resposta inválida do servidor.".to_string())?;

    if xml_response.contains("<GetEnterprisesResult>") {
        Ok("Autenticado com sucesso!".to_string())
    } else {
        Err("Credenciais inválidas. Verifique Provedor, Email e Senha.".to_string())
    }
}

// --- MÓDULO DE BANCO DE DADOS E EXCEL ---
pub struct DatabaseManager;
impl DatabaseManager {
    fn get_connection(app: &AppHandle) -> Result<Connection, String> {
        let app_data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
        }
        let db_path = app_data_dir.join("ndd_contacts.db");
        Connection::open(db_path).map_err(|e| e.to_string())
    }

    fn init_db(conn: &Connection) -> Result<(), String> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS contatos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                enterprise_name TEXT,
                tel TEXT,
                email1 TEXT,
                email2 TEXT,
                email3 TEXT,
                nome1 TEXT,
                nome2 TEXT,
                nome3 TEXT,
                consultor TEXT,
                codigo_empresa TEXT
            )",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS user_profiles (
                email TEXT PRIMARY KEY,
                name TEXT,
                title TEXT,
                department TEXT,
                phone TEXT
            )",
            [],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }
}

#[tauri::command]
fn process_excel_file(app: AppHandle, file_path: String) -> Result<String, String> {
    let mut conn = DatabaseManager::get_connection(&app)?;
    DatabaseManager::init_db(&conn)?;

    let mut workbook: Xlsx<_> =
        open_workbook(&file_path).map_err(|e| format!("Erro ao abrir Excel: {}", e))?;
    let sheet_names = workbook.sheet_names().to_owned();

    if sheet_names.is_empty() {
        return Err("A planilha não possui abas.".to_string());
    }
    let first_sheet = &sheet_names[0];

    if let Ok(range) = workbook.worksheet_range(first_sheet) {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM contatos", [])
            .map_err(|e| e.to_string())?;

        let mut rows = range.rows();
        rows.next();

        let mut stmt = tx.prepare(
            "INSERT INTO contatos (enterprise_name, tel, email1, email2, email3, nome1, nome2, nome3, consultor, codigo_empresa) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        ).map_err(|e| e.to_string())?;

        for row in rows {
            let get_val =
                |idx: usize| -> String { row.get(idx).map(|c| c.to_string()).unwrap_or_default() };
            stmt.execute(params![
                get_val(0),
                get_val(1),
                get_val(2),
                get_val(3),
                get_val(4),
                get_val(5),
                get_val(6),
                get_val(7),
                get_val(8),
                get_val(9)
            ])
            .map_err(|e| e.to_string())?;
        }
        drop(stmt);
        tx.commit().map_err(|e| e.to_string())?;
    } else {
        return Err("Não foi possível ler a primeira aba da planilha.".to_string());
    }

    Ok("Contatos importados e salvos no banco de dados local com sucesso!".to_string())
}

#[tauri::command]
fn check_has_contacts(app: AppHandle) -> Result<bool, String> {
    let conn = DatabaseManager::get_connection(&app)?;
    let mut stmt = match conn.prepare("SELECT COUNT(*) FROM contatos") {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    let count: i32 = stmt.query_row([], |row| row.get(0)).unwrap_or(0);
    Ok(count > 0)
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    message: String,
    progress: f32,
    printers: usize,
    companies: usize,
}

#[tauri::command]
async fn fetch_ndd_data(
    app: AppHandle,
    provider: String,
    email: String,
    password: String,
) -> Result<NddResult, String> {
    let encrypted_password = AuthManager::encrypt_password(&password);
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    app.emit(
        "ndd-progress",
        ProgressPayload {
            message: "Conectando à NDD e buscando empresas...".to_string(),
            progress: 5.0,
            printers: 0,
            companies: 0,
        },
    )
    .unwrap();

    let body_enterprises = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body><GetEnterprises xmlns="nddprint.com/api/"><properties>{{
                "DealerName":"{}", "DealerUserEmail":"{}", "DealerUserPassword":"{}", "FieldsList":"EnterpriseID;EnterpriseName"
            }}</properties></GetEnterprises></soap:Body>
        </soap:Envelope>"#,
        provider, email, encrypted_password
    );

    let res = client
        .post("https://api-general.nddprint.com/GeneralWS/GeneralData2.asmx")
        .header("Content-Type", "text/xml; charset=utf-8")
        .body(body_enterprises)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let xml_response = res.text().await.map_err(|e| e.to_string())?;

    let open_tag = "<GetEnterprisesResult>";
    let close_tag = "</GetEnterprisesResult>";
    let json_str = if let (Some(start), Some(end)) =
        (xml_response.find(open_tag), xml_response.find(close_tag))
    {
        &xml_response[start + open_tag.len()..end]
    } else {
        return Err("Falha ao extrair GetEnterprisesResult do XML".to_string());
    };

    let parsed_json: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| e.to_string())?;
    let mut enterprises = parsed_json
        .as_array()
        .ok_or("Formato de empresas inválido")?
        .clone();
    enterprises.sort_by(|a, b| {
        let name_a = a["EnterpriseName"].as_str().unwrap_or("");
        let name_b = b["EnterpriseName"].as_str().unwrap_or("");
        name_a.to_lowercase().cmp(&name_b.to_lowercase())
    });

    let total_enterprises = enterprises.len();
    let all_printers = Arc::new(Mutex::new(Vec::new()));
    let completed_count = Arc::new(AtomicUsize::new(0));
    let semaphore = Arc::new(Semaphore::new(20));
    let mut tasks = Vec::new();

    for enterprise in enterprises {
        let ent_id = enterprise["EnterpriseID"].as_i64().unwrap_or(0);
        let ent_name = enterprise["EnterpriseName"]
            .as_str()
            .unwrap_or("Desconhecida")
            .to_string();
        let client = client.clone();
        let provider = provider.clone();
        let email = email.clone();
        let encrypted_password = encrypted_password.clone();
        let app = app.clone();
        let all_printers = Arc::clone(&all_printers);
        let completed_count = Arc::clone(&completed_count);
        let semaphore = Arc::clone(&semaphore);

        let task = tokio::spawn(async move {
            let _permit = semaphore.acquire().await.unwrap();

            let body_printers = format!(
                r#"<?xml version="1.0" encoding="utf-8"?>
                <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body><GetPrinters xmlns="nddprint.com/api/"><properties>{{
                        "DealerName":"{}", "DealerUserEmail":"{}", "DealerUserPassword":"{}", "EnterpriseID":"{}",
                        "FieldsList":"PrinterDeviceID;EnterpriseID;EnterpriseName;SiteID;SiteName;SiteDivisionName;PrinterName;BrandName;ModelName;SerialNumber;AddressName;Location;ContactData;LastNSLDate;EnabledCounters;CustomFields"
                    }}</properties></GetPrinters></soap:Body>
                </soap:Envelope>"#,
                provider, email, encrypted_password, ent_id
            );

            let res_printers = client
                .post("https://api-general.nddprint.com/GeneralWS/GeneralData2.asmx")
                .header("Content-Type", "text/xml; charset=utf-8")
                .body(body_printers)
                .send()
                .await;

            if let Ok(res) = res_printers {
                if let Ok(xml_printers) = res.text().await {
                    if let (Some(start), Some(end)) = (
                        xml_printers.find("<GetPrintersResult>"),
                        xml_printers.find("</GetPrintersResult>"),
                    ) {
                        let printers_json_str = &xml_printers[start + 19..end];
                        if let Ok(mut printers_arr) =
                            serde_json::from_str::<Vec<serde_json::Value>>(printers_json_str)
                        {
                            let mut lock = all_printers.lock().await;
                            lock.append(&mut printers_arr);
                        }
                    }
                }
            }

            let count = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
            let current_progress = 5.0 + ((count as f32 / total_enterprises as f32) * 90.0);
            let total_printers_now = {
                let lock = all_printers.lock().await;
                lock.len()
            };

            let _ = app.emit(
                "ndd-progress",
                ProgressPayload {
                    message: format!("{} ({}/{})", ent_name, count, total_enterprises),
                    progress: current_progress,
                    printers: total_printers_now,
                    companies: count,
                },
            );
        });
        tasks.push(task);
    }

    for task in tasks {
        let _ = task.await;
    }

    let total_impressoras = {
        let lock = all_printers.lock().await;
        lock.len()
    };
    app.emit(
        "ndd-progress",
        ProgressPayload {
            message: "Cruzando dados com o Banco Local...".to_string(),
            progress: 95.0,
            printers: total_impressoras,
            companies: total_enterprises,
        },
    )
    .unwrap();

    let final_printers = all_printers.lock().await;
    let mut contacts_map: HashMap<String, serde_json::Value> = HashMap::new();

    {
        let conn = DatabaseManager::get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT enterprise_name, tel, email1, email2, email3, nome1, nome2, nome3, consultor, codigo_empresa FROM contatos").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            let ent_name: String = row.get(0).unwrap_or_default();
            Ok((ent_name, serde_json::json!({
                "tel": row.get::<_, String>(1).unwrap_or_default(), "email1": row.get::<_, String>(2).unwrap_or_default(),
                "email2": row.get::<_, String>(3).unwrap_or_default(), "email3": row.get::<_, String>(4).unwrap_or_default(),
                "nome1": row.get::<_, String>(5).unwrap_or_default(), "nome2": row.get::<_, String>(6).unwrap_or_default(),
                "nome3": row.get::<_, String>(7).unwrap_or_default(), "consultor": row.get::<_, String>(8).unwrap_or_default(),
                "codigo_empresa": row.get::<_, String>(9).unwrap_or_default(),
            })))
        }).map_err(|e| e.to_string())?;

        for row in rows {
            if let Ok((name, json_data)) = row {
                contacts_map.insert(name.to_uppercase().trim().to_string(), json_data);
            }
        }
    }

    let mut processed_printers = Vec::new();
    let data_atual = Utc::now().naive_utc();
    let mut count_2001 = 0;
    let mut count_esporadico = 0;
    let mut count_match_sqlite = 0;
    let mut unique_initial = std::collections::HashSet::new();
    let mut unique_after_disabled = std::collections::HashSet::new();
    let mut unique_after_brand = std::collections::HashSet::new();
    let mut drop_disabled_printers = 0;
    let mut drop_brand_printers = 0;

    for p in final_printers.iter() {
        let mut printer = p.clone();
        let ent_name = printer["EnterpriseName"].as_str().unwrap_or("").to_string();
        let ent_name_upper = ent_name.to_uppercase().trim().to_string();
        unique_initial.insert(ent_name_upper.clone());

        if !printer["EnabledCounters"].as_bool().unwrap_or(false) {
            drop_disabled_printers += 1;
            continue;
        }
        unique_after_disabled.insert(ent_name_upper.clone());

        let brand = printer["BrandName"].as_str().unwrap_or("");
        if !["Canon", "Brother", "Oce", "OKI"].contains(&brand) {
            drop_brand_printers += 1;
            continue;
        }
        unique_after_brand.insert(ent_name_upper.clone());

        let mut days_offline: i64 = 0;
        let mut is_2001 = false;

        if let Some(d) = printer["Days without meters"]
            .as_i64()
            .or_else(|| printer["DaysWithoutMeters"].as_i64())
        {
            days_offline = d;
        } else if let Some(date_str) = printer["LastNSLDate"].as_str() {
            if date_str.contains("2001") {
                is_2001 = true;
                count_2001 += 1;
            }
            let clean_date = date_str.replace("T", " ").replace("Z", "");
            let date_without_ms = clean_date.split('.').next().unwrap_or(&clean_date).trim();
            let parsed_date = NaiveDateTime::parse_from_str(date_without_ms, "%Y-%m-%d %H:%M:%S")
                .or_else(|_| NaiveDateTime::parse_from_str(date_without_ms, "%d/%m/%Y %H:%M:%S"))
                .or_else(|_| {
                    NaiveDateTime::parse_from_str(
                        &format!("{} 00:00:00", date_without_ms),
                        "%Y-%m-%d %H:%M:%S",
                    )
                });

            if let Ok(last_date) = parsed_date {
                days_offline = (data_atual - last_date).num_days();
            }
        }

        let mut passivel = "SIM";
        let mut motivo = "";
        if is_2001 {
            passivel = "NÃO";
            motivo = "Equipamento não compatível (Data 2001)";
        } else if ["GESTAMP", "DEFENSORIA", "HOSPITAL PAULISTA"]
            .iter()
            .any(|&s| ent_name_upper.contains(s))
        {
            passivel = "NÃO";
            motivo = "Cliente Esporádico";
            count_esporadico += 1;
        }

        let (tel, email1, email2, email3, nome1, nome2, nome3, consultor, codigo_empresa) =
            match contacts_map.get(&ent_name_upper) {
                Some(contact) => {
                    count_match_sqlite += 1;
                    (
                        contact["tel"].as_str().unwrap_or(""),
                        contact["email1"].as_str().unwrap_or(""),
                        contact["email2"].as_str().unwrap_or(""),
                        contact["email3"].as_str().unwrap_or(""),
                        contact["nome1"].as_str().unwrap_or(""),
                        contact["nome2"].as_str().unwrap_or(""),
                        contact["nome3"].as_str().unwrap_or(""),
                        contact["consultor"].as_str().unwrap_or(""),
                        contact["codigo_empresa"].as_str().unwrap_or(""),
                    )
                }
                None => ("", "", "", "", "", "", "", "", ""),
            };

        if let Some(obj) = printer.as_object_mut() {
            obj.insert(
                "Days without meters".to_string(),
                serde_json::json!(days_offline),
            );
            obj.insert(
                "Passivel de Monitoramento".to_string(),
                serde_json::json!(passivel),
            );
            obj.insert(
                "Motivo Nao Monitoramento".to_string(),
                serde_json::json!(motivo),
            );
            obj.insert("tel".to_string(), serde_json::json!(tel));
            obj.insert("email1".to_string(), serde_json::json!(email1));
            obj.insert("email2".to_string(), serde_json::json!(email2));
            obj.insert("email3".to_string(), serde_json::json!(email3));
            obj.insert("nome1".to_string(), serde_json::json!(nome1));
            obj.insert("nome2".to_string(), serde_json::json!(nome2));
            obj.insert("nome3".to_string(), serde_json::json!(nome3));
            obj.insert("consultor".to_string(), serde_json::json!(consultor));
            obj.insert(
                "codigo_empresa".to_string(),
                serde_json::json!(codigo_empresa),
            );
        }
        processed_printers.push(printer);
    }

    let log_verificacao = format!(
        "Verificação de Tratativas:\n- Total Processado: {}\n- Encontrados no Banco (SQLite): {}\n- Detectados (Data 2001): {}\n- Clientes Esporádicos: {}",
        processed_printers.len(), count_match_sqlite, count_2001, count_esporadico
    );

    app.emit(
        "ndd-progress",
        ProgressPayload {
            message: "Processamento concluído!".to_string(),
            progress: 100.0,
            printers: final_printers.len(),
            companies: total_enterprises,
        },
    )
    .unwrap();

    let initial_companies = unique_initial.len();
    let drop_disabled_companies = initial_companies - unique_after_disabled.len();
    let drop_brand_companies = unique_after_disabled.len() - unique_after_brand.len();

    Ok(NddResult {
        report: log_verificacao,
        data: processed_printers.clone(),
        stats: FilteringStats {
            initial_printers: final_printers.len(),
            initial_companies,
            drop_disabled_printers,
            drop_disabled_companies,
            drop_brand_printers,
            drop_brand_companies,
            flag_2001: count_2001,
            flag_sporadic: count_esporadico,
            matched_sqlite: count_match_sqlite,
            final_printers: processed_printers.len(),
            final_companies: unique_after_brand.len(),
        },
    })
}

#[tauri::command]
fn get_all_contacts(app: AppHandle) -> Result<Vec<Contact>, String> {
    let conn = DatabaseManager::get_connection(&app)?;
    let mut stmt = conn.prepare("SELECT id, enterprise_name, tel, email1, email2, email3, nome1, nome2, nome3, consultor, codigo_empresa FROM contatos ORDER BY enterprise_name ASC").map_err(|e| e.to_string())?;

    let contacts = stmt
        .query_map([], |row| {
            Ok(Contact {
                id: row.get(0).ok(),
                enterprise_name: row.get::<_, String>(1).unwrap_or_default(),
                tel: row.get::<_, String>(2).unwrap_or_default(),
                email1: row.get::<_, String>(3).unwrap_or_default(),
                email2: row.get::<_, String>(4).unwrap_or_default(),
                email3: row.get::<_, String>(5).unwrap_or_default(),
                nome1: row.get::<_, String>(6).unwrap_or_default(),
                nome2: row.get::<_, String>(7).unwrap_or_default(),
                nome3: row.get::<_, String>(8).unwrap_or_default(),
                consultor: row.get::<_, String>(9).unwrap_or_default(),
                codigo_empresa: row.get::<_, String>(10).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for contact in contacts {
        if let Ok(c) = contact {
            result.push(c);
        }
    }
    Ok(result)
}

#[tauri::command]
fn save_contact(app: AppHandle, contact: Contact) -> Result<String, String> {
    let conn = DatabaseManager::get_connection(&app)?;
    if let Some(id) = contact.id {
        conn.execute("UPDATE contatos SET enterprise_name=?1, tel=?2, email1=?3, email2=?4, email3=?5, nome1=?6, nome2=?7, nome3=?8, consultor=?9, codigo_empresa=?10 WHERE id=?11", params![contact.enterprise_name, contact.tel, contact.email1, contact.email2, contact.email3, contact.nome1, contact.nome2, contact.nome3, contact.consultor, contact.codigo_empresa, id]).map_err(|e| e.to_string())?;
        Ok("Contato atualizado com sucesso!".to_string())
    } else {
        conn.execute("INSERT INTO contatos (enterprise_name, tel, email1, email2, email3, nome1, nome2, nome3, consultor, codigo_empresa) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![contact.enterprise_name, contact.tel, contact.email1, contact.email2, contact.email3, contact.nome1, contact.nome2, contact.nome3, contact.consultor, contact.codigo_empresa]).map_err(|e| e.to_string())?;
        Ok("Novo contato adicionado com sucesso!".to_string())
    }
}

#[tauri::command]
fn export_contacts_to_excel(app: AppHandle, file_path: String) -> Result<String, String> {
    let contacts = get_all_contacts(app.clone())?;

    // Agora usamos o file_path que o usuário escolheu na caixa de diálogo do Windows!
    let mut workbook = Workbook::new(&file_path);
    let worksheet = workbook.add_worksheet();
    let fmt = Format::new();

    let headers = [
        "EnterpriseName",
        "tel",
        "email1",
        "email2",
        "email3",
        "nome1",
        "nome2",
        "nome3",
        "consultor",
        "codigo_empresa",
    ];
    for (i, title) in headers.iter().enumerate() {
        worksheet
            .write_string(0, i as u16, *title, &fmt)
            .map_err(|e| e.to_string())?;
    }

    for (r_idx, c) in contacts.iter().enumerate() {
        let r = (r_idx + 1) as u32;
        worksheet
            .write_string(r, 0, &c.enterprise_name, &fmt)
            .unwrap();
        worksheet.write_string(r, 1, &c.tel, &fmt).unwrap();
        worksheet.write_string(r, 2, &c.email1, &fmt).unwrap();
        worksheet.write_string(r, 3, &c.email2, &fmt).unwrap();
        worksheet.write_string(r, 4, &c.email3, &fmt).unwrap();
        worksheet.write_string(r, 5, &c.nome1, &fmt).unwrap();
        worksheet.write_string(r, 6, &c.nome2, &fmt).unwrap();
        worksheet.write_string(r, 7, &c.nome3, &fmt).unwrap();
        worksheet.write_string(r, 8, &c.consultor, &fmt).unwrap();
        worksheet
            .write_string(r, 9, &c.codigo_empresa, &fmt)
            .unwrap();
    }
    workbook.close().map_err(|e| e.to_string())?;
    Ok(format!("Base de contatos salva com sucesso!"))
}

#[tauri::command]
async fn export_to_excel(app: AppHandle, data: Vec<serde_json::Value>) -> Result<String, String> {
    let docs_dir = app.path().document_dir().map_err(|e| e.to_string())?;
    let path = docs_dir.join("Relatorio_NDD_Recovery.xlsx");
    let path_str = path.to_str().ok_or("Erro no caminho")?;

    let mut workbook = Workbook::new(path_str);
    let worksheet = workbook.add_worksheet();
    let fmt = Format::new();

    let headers = [
        "PrinterDeviceID",
        "EnterpriseID",
        "EnterpriseName",
        "SiteID",
        "SiteName",
        "SiteDivisionName",
        "PrinterName",
        "BrandName",
        "ModelName",
        "SerialNumber",
        "AddressName",
        "Location",
        "ContactData",
        "LastNSLDate",
        "Passivel de Monitoramento",
        "Motivo Nao Monitoramento",
        "Days without meters",
        "Telefone",
        "Email 1",
        "Email 2",
        "Email 3",
        "Nome 1",
        "Nome 2",
        "Nome 3",
        "Consultor",
        "Código Empresa",
    ];

    for (i, title) in headers.iter().enumerate() {
        worksheet.write_string(0, i as u16, *title, &fmt).unwrap();
    }

    for (r_idx, item) in data.iter().enumerate() {
        let r = (r_idx + 1) as u32;
        let get_val = |key: &str| -> String {
            match &item[key] {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => "".to_string(),
            }
        };

        worksheet
            .write_string(r, 0, &get_val("PrinterDeviceID"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 1, &get_val("EnterpriseID"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 2, &get_val("EnterpriseName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 3, &get_val("SiteID"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 4, &get_val("SiteName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 5, &get_val("SiteDivisionName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 6, &get_val("PrinterName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 7, &get_val("BrandName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 8, &get_val("ModelName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 9, &get_val("SerialNumber"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 10, &get_val("AddressName"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 11, &get_val("Location"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 12, &get_val("ContactData"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 13, &get_val("LastNSLDate"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 14, &get_val("Passivel de Monitoramento"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 15, &get_val("Motivo Nao Monitoramento"), &fmt)
            .unwrap();

        let days = match &item["Days without meters"] {
            serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
            serde_json::Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
            _ => 0.0,
        };
        worksheet.write_number(r, 16, days, &fmt).unwrap();

        worksheet
            .write_string(r, 17, &get_val("tel"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 18, &get_val("email1"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 19, &get_val("email2"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 20, &get_val("email3"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 21, &get_val("nome1"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 22, &get_val("nome2"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 23, &get_val("nome3"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 24, &get_val("consultor"), &fmt)
            .unwrap();
        worksheet
            .write_string(r, 25, &get_val("codigo_empresa"), &fmt)
            .unwrap();
    }
    workbook.close().map_err(|e| e.to_string())?;
    Ok(format!("Salvo com sucesso em: {}", path_str))
}

#[tauri::command]
fn ensure_contacts_exist(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    let conn = DatabaseManager::get_connection(&app)?;
    for name in names {
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM contatos WHERE UPPER(enterprise_name) = UPPER(?1)")
            .map_err(|e| e.to_string())?;
        let count: i64 = stmt.query_row([&name], |row| row.get(0)).unwrap_or(0);
        if count == 0 {
            conn.execute("INSERT INTO contatos (enterprise_name, email1, email2, email3, tel, nome1, nome2, nome3, consultor, codigo_empresa) VALUES (?1, '', '', '', '', '', '', '', '', '')", [&name]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_contact(id: i32) -> Result<(), String> {
    let conn = rusqlite::Connection::open("contacts.db").map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM contacts WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn send_test_email(
    user_email: String,
    user_pass: String,
    target_email: String,
) -> Result<String, String> {
    let email_message = Message::builder()
        .from(user_email.parse().map_err(|_| "E-mail de origem inválido")?)
        .to(target_email.parse().map_err(|_| "E-mail de destino inválido")?)
        .subject("[TESTE DEV] NDD Recovery - Conexão Bem Sucedida!")
        .header(ContentType::TEXT_HTML)
        .body(String::from(
            "<h1>🚀 Sucesso Absoluto!</h1><p>O motor de envio do Rust está pronto para disparar a fábrica da IA.</p>"
        )).unwrap();

    let creds = Credentials::new(user_email.clone(), user_pass);
    let mailer = SmtpTransport::relay("smtp.gmail.com")
        .unwrap()
        .credentials(creds)
        .build();

    match mailer.send(&email_message) {
        Ok(_) => Ok("E-mail de teste disparado com sucesso!".to_string()),
        Err(e) => Err(format!("Falha no Gmail SMTP: {}", e)),
    }
}

async fn fetch_gemini_template(
    client: &reqwest::Client,
    key: &str,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={}", key);
    let body = serde_json::json!({ "contents": [{ "parts": [{ "text": prompt }] }] });

    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json_text = res.text().await.map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&json_text).map_err(|e| e.to_string())?;

    if let Some(text) = parsed["candidates"][0]["content"]["parts"][0]["text"].as_str() {
        Ok(text.replace("```html", "").replace("```", ""))
    } else {
        Err("O Gemini não retornou o formato esperado.".to_string())
    }
}

#[tauri::command]
fn get_user_profile(app: AppHandle, email: String) -> Result<UserProfile, String> {
    let conn = DatabaseManager::get_connection(&app)?;
    DatabaseManager::init_db(&conn)?; // <--- MÁGICA 1: Garante que a tabela exista antes de buscar!

    let mut stmt = conn
        .prepare("SELECT name, title, department, phone FROM user_profiles WHERE email = ?1")
        .map_err(|e| e.to_string())?;
    let profile = stmt
        .query_row([&email], |row| {
            Ok(UserProfile {
                email: email.clone(),
                name: row.get(0).unwrap_or_default(),
                title: row.get(1).unwrap_or_default(),
                department: row.get(2).unwrap_or_default(),
                phone: row.get(3).unwrap_or_default(),
            })
        })
        .unwrap_or(UserProfile {
            email,
            name: "".to_string(),
            title: "".to_string(),
            department: "".to_string(),
            phone: "".to_string(),
        });

    Ok(profile)
}

#[tauri::command]
fn save_user_profile(app: AppHandle, profile: UserProfile) -> Result<String, String> {
    let conn = DatabaseManager::get_connection(&app)?;
    DatabaseManager::init_db(&conn)?; // <--- MÁGICA 2: Garante a tabela antes de salvar!

    conn.execute(
        "INSERT OR REPLACE INTO user_profiles (email, name, title, department, phone) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![profile.email, profile.name, profile.title, profile.department, profile.phone]
    ).map_err(|e| e.to_string())?;
    Ok("Perfil salvo!".to_string())
}

#[tauri::command]
async fn process_and_send_emails(
    app: AppHandle,
    user_email: String,
    user_pass: String,
    gemini_key: String,
    offline_days_threshold: i64,
    send_to_host_offline: bool,
    send_to_printer_offline: bool,
    is_dev_mode: bool,
    data: Vec<serde_json::Value>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let prompt_host = "Escreva o corpo de um e-mail amigável, em HTML puro, para um cliente corporativo. Avise que possivelmente o programa NDD Print Host da empresa dele está offline, pois NENHUMA impressora comunica há dias. Peça para o TI verificar se o servidor está ligado e se os serviços do NDD estão rodando. Não coloque cabeçalho <head> ou tags <html> globais. Use '{NOME}' como variável para o nome do contato. No final, coloque a exata tag '{TABELA}' onde a lista de impressoras deve aparecer. REGRA CRÍTICA: Alinhe todas as tags à esquerda (text-align: left). O e-mail DEVE terminar ESTRITAMENTE com a palavra 'Atenciosamente,', sem adicionar NENHUMA assinatura genérica depois disso (não escreva 'Sua equipe', etc). Seja educado, humano e objetivo.";

    let prompt_isolated = "Escreva o corpo de um e-mail amigável, em HTML puro, para um cliente corporativo. Avise que ALGUMAS impressoras específicas da rede deles perderam a comunicação com o portal NDD. Peça para verificarem se os equipamentos foram desligados ou trocaram de IP. Não coloque cabeçalho <head> ou tags <html> globais. Use '{NOME}' como variável para o nome do contato. No final, coloque a exata tag '{TABELA}' onde a lista de máquinas vai aparecer. REGRA CRÍTICA: Alinhe todas as tags à esquerda (text-align: left). O e-mail DEVE terminar ESTRITAMENTE com a palavra 'Atenciosamente,', sem adicionar NENHUMA assinatura genérica depois disso (não escreva 'Sua equipe', etc). Seja prestativo e humano.";

    let template_host = if send_to_host_offline {
        fetch_gemini_template(&client, &gemini_key, prompt_host).await?
    } else {
        "".to_string()
    };
    let template_isolated = if send_to_printer_offline {
        fetch_gemini_template(&client, &gemini_key, prompt_isolated).await?
    } else {
        "".to_string()
    };

    let mut companies_map: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    for p in data {
        if p["Passivel de Monitoramento"] == "NÃO" {
            continue;
        }
        let ent_name = p["EnterpriseName"]
            .as_str()
            .unwrap_or("Desconhecida")
            .to_string();
        companies_map
            .entry(ent_name)
            .or_insert_with(Vec::new)
            .push(p);
    }

    let creds = Credentials::new(user_email.clone(), user_pass);
    let mailer = SmtpTransport::relay("smtp.gmail.com")
        .map_err(|e| e.to_string())?
        .credentials(creds)
        .build();

    // Busca o perfil do usuário no banco local
    let profile = get_user_profile(app.clone(), user_email.clone()).unwrap_or(UserProfile {
        email: user_email.clone(),
        name: "Equipe Canon".to_string(),
        title: "".to_string(),
        department: "".to_string(),
        phone: "".to_string(),
    });

    // MÁGICA CID: Lê o arquivo local e injeta invisivelmente no pacote do e-mail
    let logo_bytes = include_bytes!("canon_logo.png");

    // HTML da Assinatura: Tamanho ajustado (180px), sem linha divisória e alinhamento profissional
    let signature_html = format!(
        r#"<br><br><table border="0" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; border-collapse: collapse; margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 20px;"><tr><td valign="top" style="padding-right: 30px;"><img src="cid:canon_logo.png" alt="Canon" style="display: block; width: 180px; height: auto;"></td><td valign="top" style="padding-left: 10px;"><div style="font-size: 14px; line-height: 1.6; color: #1f2937;"><strong style="font-size: 16px; color: #111827;">{}</strong><br>{}<br>{}<br><br><strong>Canon do Brasil Indústria e Comércio Ltda.</strong><br>Av. do Café, 277 - 6º andar Torre B - Vila Guarani<br>São Paulo, Brasil - CEP: 04311-000<br><br><a href="https://www.canon.com.br" style="color: #ed1c24; text-decoration: none;">www.canon.com.br</a><br><a href="mailto:{}" style="color: #ed1c24; text-decoration: none;">{}</a><br><strong style="color: #111827;">Cel: {}</strong></div></td></tr></table>"#,
        profile.name,
        profile.title,
        profile.department,
        profile.email,
        profile.email,
        profile.phone
    );

    let mut emails_enviados = 0;
    let mut empresas_processadas = 0;

    for (empresa, impressoras) in companies_map {
        if is_dev_mode && empresas_processadas >= 4 {
            break;
        }

        let email_cliente = impressoras[0]["email1"].as_str().unwrap_or("").to_string();
        let nome_cliente = impressoras[0]["nome1"]
            .as_str()
            .unwrap_or("Equipe TI")
            .to_string();
        if email_cliente.is_empty() && !is_dev_mode {
            continue;
        }

        let total_printers = impressoras.len();
        let mut offline_printers = Vec::new();

        // Vamos guardar os dias para analisar as quedas simultâneas
        let mut offline_days_list = Vec::new();

        for p in &impressoras {
            let days = match &p["Days without meters"] {
                serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
                serde_json::Value::String(s) => s.parse::<i64>().unwrap_or(0),
                _ => 0,
            };
            if days >= offline_days_threshold {
                offline_printers.push(p.clone());
                offline_days_list.push(days); // Guarda o dia para análise
            }
        }

        if offline_printers.is_empty() {
            continue;
        }

        // MÁGICA DE CORRELAÇÃO: Qual foi o maior "apagão" no mesmo dia?
        use std::collections::HashMap;
        let mut days_count = HashMap::new();
        let mut max_simultaneous_drops = 0;
        for &d in &offline_days_list {
            let count = days_count.entry(d).or_insert(0);
            *count += 1;
            if *count > max_simultaneous_drops {
                max_simultaneous_drops = *count;
            }
        }

        // A NOVA REGRA DE OURO DO HOST OFFLINE (Correlação de falhas)
        // É Host se: Tem 2+ impressoras no total E 2+ caíram juntas E essa queda representa 50%+ do parque
        let is_host_offline = total_printers >= 2
            && max_simultaneous_drops >= 2
            && (max_simultaneous_drops as f64) >= (total_printers as f64 / 2.0);

        if is_host_offline && !send_to_host_offline {
            continue;
        }
        if !is_host_offline && !send_to_printer_offline {
            continue;
        }

        let _ = app.emit(
            "email-dispatch-event",
            format!("⚙️ Gerando e-mail para {}...", empresa),
        );

        let base_template = if is_host_offline {
            &template_host
        } else {
            &template_isolated
        };
        let subject = if is_host_offline {
            format!("Verificação de Servidor NDD Print Host - {}", empresa)
        } else {
            format!("Impressoras sem comunicação com o NDD - {}", empresa)
        };

        // Monta o Cabeçalho da Tabela HTML com a nova coluna 'Série'
        let mut tabela_html = String::from(
            "<table style='width: 100%; border-collapse: collapse; margin-top: 20px; font-family: sans-serif; font-size: 14px;'>
            <thead style='background-color: #f4f4f5; border-bottom: 2px solid #d4d4d8;'>
                <tr>
                    <th style='padding: 10px; text-align: left;'>Modelo</th>
                    <th style='padding: 10px; text-align: left;'>Série</th>
                    <th style='padding: 10px; text-align: left;'>Endereço/IP</th>
                    <th style='padding: 10px; text-align: left;'>Localização</th>
                    <th style='padding: 10px; text-align: left;'>Dias Offline</th>
                </tr>
            </thead>
            <tbody>"
        );

        // Preenche as linhas da tabela injetando o SerialNumber
        for p in offline_printers {
            tabela_html.push_str(&format!(
                "<tr style='border-bottom: 1px solid #e4e4e7;'>
                    <td style='padding: 10px;'>{}</td>
                    <td style='padding: 10px; color: #4f46e5; font-weight: 500;'>{}</td>
                    <td style='padding: 10px;'>{}</td>
                    <td style='padding: 10px;'>{}</td>
                    <td style='padding: 10px; color: #dc2626; font-weight: bold;'>{}</td>
                </tr>",
                p["ModelName"].as_str().unwrap_or("-"),
                p["SerialNumber"].as_str().unwrap_or("-"), // <--- A NOVA COLUNA AQUI
                p["AddressName"].as_str().unwrap_or("-"),
                p["Location"].as_str().unwrap_or("-"),
                p["Days without meters"].as_i64().unwrap_or(0)
            ));
        }
        tabela_html.push_str("</tbody></table>");

        // Envelopa TUDO em uma div forçando o alinhamento à esquerda e fonte padrão
        let final_body = format!(
            "<div style='text-align: left; font-family: Arial, sans-serif; color: #1f2937;'>{}{}</div>", 
            base_template.replace("{NOME}", &nome_cliente).replace("{TABELA}", &tabela_html), 
            signature_html
        );
        let target_email = if is_dev_mode {
            user_email.clone()
        } else {
            email_cliente.clone()
        };
        let subject_final = if is_dev_mode {
            format!("[TESTE DEV] {}", subject)
        } else {
            subject
        };

        // --- ENGENHARIA DA IMAGEM INLINE (MULTIPART RELATED) ---
        let html_part = lettre::message::SinglePart::builder()
            .header(ContentType::TEXT_HTML)
            .body(final_body);

        let logo_bytes = include_bytes!("canon_logo.png");
        let image_part = lettre::message::SinglePart::builder()
            .header(lettre::message::header::ContentType::parse("image/png").unwrap())
            .header(lettre::message::header::ContentDisposition::inline())
            .header(lettre::message::header::ContentId::from(format!(
                "<{}>",
                "canon_logo.png"
            )))
            .body(logo_bytes.to_vec());

        let multi = lettre::message::MultiPart::related()
            .singlepart(html_part)
            .singlepart(image_part);

        let email_message = match Message::builder()
            .from(user_email.parse().unwrap())
            .to(target_email.parse().unwrap())
            .subject(subject_final)
            .multipart(multi)
        {
            // <-- Manda o pacote com a imagem embutida
            Ok(m) => m,
            Err(e) => {
                let _ = app.emit(
                    "email-dispatch-event",
                    format!("❌ Erro na montagem: {}", e),
                );
                continue;
            }
        };

        match mailer.send(&email_message) {
            Ok(_) => {
                emails_enviados += 1;
                let _ = app.emit(
                    "email-dispatch-event",
                    format!("✅ Sucesso: {}", target_email),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "email-dispatch-event",
                    format!("❌ Erro ({target_email}): {e}"),
                );
            }
        }
        empresas_processadas += 1;
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }

    let _ = app.emit(
        "email-dispatch-event",
        "🏳️ OPERAÇÃO FINALIZADA.".to_string(),
    );
    Ok(format!(
        "{} e-mails processados e disparados!",
        emails_enviados
    ))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            handle_login,
            process_excel_file,
            check_has_contacts,
            fetch_ndd_data,
            export_to_excel,
            get_all_contacts,
            save_contact,
            export_contacts_to_excel,
            ensure_contacts_exist,
            delete_contact,
            send_test_email,
            process_and_send_emails,
            get_user_profile,
            save_user_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
