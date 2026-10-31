# Statistika planı (analytics roadmap)

Məqsəd: Ovlink-i "link qısaldıcı"dan **biznes üçün statistika platforması**na çevirmək.
Hər rəqəm real olmalıdır (uydurma/ratio təxmin yox), sorğular O(1)-ə yaxın olmalıdır.

---

## Sprint 1 — Vəqf ✅ (tamamlandı)

| İş | Fayl |
|---|---|
| `clicks` sütunları: `ip_hash`, `referrer_host`, `utm_source/medium/campaign`, `device_type`, `is_bot`, `variant`, `region` | `src/db/migrate.js` |
| `link_stats_daily` (günlük rollup) + `click_uniques` (unikal arbiteri) + kompozit indekslər | `src/db/migrate.js` |
| Klik toplama: referrer, UTM, cihaz, bot bayrağı, ip_hash, A/B variantı | `src/lib/analytics.js` |
| A/B variantını kliklə birlikdə yazmaq (`resolveFinalRedirectTarget`) | `src/routes/redirect.js` |
| `/api/stats` yenidən yazılışı: SQL aqreqasiya, `days`, `bots`, `limit`, real unikal | `src/routes/api/analytics.js` |
| Saxta `unique_visitors = clicks * 0.85` silindi | `views/stats-page.ejs` |
| Ölü dublikat handler silindi | `src/routes/api/links.js` |
| Testlər + sənəd | `test/analytics-stats.test.js`, `SECURITY.md` |

Nəticə: unikal ziyarətçi artıq **dəqiq**, mənbə/UTM/cihaz/bot/A-B dataları yazılır,
stats endpoint-i bütün klik sətirlərini RAM-a yükləmir.

---

## Sprint 2 — İnteqrasiya və UI ✅ (tamamlandı)

**Backend**
1. ✅ `src/lib/link-stats.js` — hesablama servis qatı (route, Pro API və export eyni kodu işlədir).
2. ✅ `GET /api/pro/v1/links/:short/stats` — API açarı ilə statistika (`days`, `bots`); link sahibliyi yoxlanır.
3. ✅ `GET /api/stats/:short/export` və `GET /api/pro/v1/links/:short/clicks` — saat/səviyyəsində CSV/JSON export (formula injection qoruması ilə).
4. ✅ Dövr müqayisəsi: `previous` + `deltas.clicks_percent/uniques_percent` (eyni uzunluqlu əvvəlki pəncərə).

**UI (`views/stats-page.ejs`)**
5. ✅ Mənbələr paneli (referrer + «direct»).
6. ✅ Cihazlar paneli + bot faizi (`bots_total / clicks_total`).
7. ✅ A/B paneli (yalnız test varsa görünür, lider göstərilir).
8. ✅ Export düymələri server endpointinə keçdi (tam atribut kolonları, 20k sətirə qədər).
9. ✅ ilkin fetch `?days=90&limit=2000` — bütün klient filtrləri dəqiq, “all” KPI rollup-dan.
10. ✅ Yeni i18n açarları (az/tr/en): `stats_top_sources`, `stats_devices`, `stats_ab_variants`.

---

## Sprint 3 — Biznes qatı (cari)

9. ✅ **Konversiya izləmə** — hədəf səhifəyə 1×1 pixel əlavə olunur:
   ```html
   <img src="https://ovlink.sbs/c/abc123.gif?goal=signup" width="1" height="1" alt="" />
   ```
   - `link_conversions` cədvəli: `(url_id, goal, day, ip_hash)` unikal → refresh şişirtməsi yoxdur
   - `link_stats_daily.conversions` rollup sütunu
   - `/api/stats` → `conversions_total/range`, `conversion_rate`, `goals`, `conversions_by_day`, `conversion_pixel_path`
   - UI: “Konversiyalar” paneli (yalnız konversiya olduqda görünür) + pixel nümunəsi
10. ✅ **Kampaniyalar**
    - `campaigns` cədvəli (owner-scoped, slug unikal) + `urls.campaign_id`
    - `GET/POST /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/:id`
    - `GET/POST /api/links/:short/campaign` — linki kampaniyaya bağlamaq/çıxarmaq
    - `GET /api/campaigns/:id?days=` — bütün linklər üzrə agreqat: klik, unikal, konversiya, günlük seriya, top linklər, mənbələr, goal-lar
    - `/api/shorten` və Pro `/api/pro/v1/shorten` `campaign_id` qəbul edir
    - **UI**: `/campaigns` səhifəsi (yaratma forması, KPI cədvəli, detal görünüsü, qrafik, silmə) + navbar linki (az/tr/en)
    - Kampaniya silinəndə linklər qalır (yalnız qruplaşma silinir)
11. ✅ **Avtomatik hesabat** — opt-in həftəlik e-poçt:
    - `users.stats_report_enabled` + `stats_report_last_sent_at`
    - `GET/POST /api/user/stats-report` (toggle) + stats səhifəsində “Həftəlik hesabat” düyməsi
    - `src/lib/stats-report.js`: `loadWeeklySummary` (7 gün vs əvvəlki 7 gün), `sendWeeklyStatsReports` (6 saatlıq worker, 6 günlük resend guard, boş hesablara göndərmir)
    - `email.js`: `buildStatsReportContent` (saf, test edilə bilən) + `sendStatsReportEmail` (KPI cədvəli, top 5 link, mənbə, Δ%)
12. ✅ **Paylaşılan statistika** — imzalı/expiring read-only link + embed widget:
    - `stats_shares` cədvəli, yalnız **SHA-256(token)** saxlanır, `expires_at` + `revoked_at`
    - `POST /api/stats/:short/share { days: 7|30|90|365 }` → `url`, `embed_url`, `embed_code`
    - `GET /api/stats/:short/shares`, `POST /api/stats/:short/share/revoke { id }`
    - `GET /api/stats/shared/:short?token=` (klik sətirləri **göndərilmir**)
    - `GET /stats/shared/:short?token=` — public hesabat səhifəsi (az/tr/en, `noindex`, `no-referrer`)
    - `GET /embed/:short?token=` — server-rendered 320×150 kart, `frame-ancestors *`
13. ✅ **Anomaliya xəbərdarlığı** — `src/lib/anomaly-alerts.js`
    - `detectSeriesAnomalies` (saf funksiya): hər günü əvvəlki 7 günün ortalaması ilə müqayisə edir
    - **Partlayış**: `clicks >= max(25, 3×orta)` və orta `>= 2` → səs-küy yoxdur
    - **Düşmə**: orta `>= 10` və `clicks <= 0.3×orta`, yalnız günün 12:00 (UTC)-dən sonrası (natamam gün yalançı siqnal vermir)
    - **Limit**: `max_clicks`-in 80%-nə çatanda erkən xəbərdarlıq
    - **Hədəf nasazlığı**: `link_stats_daily`-də son 7 gündə ≥3 klik almış linklərin hədəfi `HEAD`-siz `GET` ilə yoxlanılır (2xx/3xx = sağlam, 4xx/5xx = nasaz). Sorğu **pinned-IP** ilə gedir: `resolveDestinationTarget` özəl IP/port/host bloklarını (`isBlockedWebhookIp/Port/Hostname`) tətbiq edir, redirect izlənmir, yalnız status kodu saxlanılır → SSRF/port-scan mümkün deyil
    - **Dedupe**: `notifications (user_id, event_key)` unikal indeksi — `anomaly_spike_<short>_<gün>`; eyni anomaliya gündə bir dəfə bildirilir
    - **Kanallar**: tətbiqdaxili bildiriş (az/tr/en) + Pro üçün webhook (`stats.anomaly.spike`, `stats.anomaly.drop`, `stats.limit.warning`, `stats.link.down`) + `sendOpsAlert` (Telegram/webhook, 10 dəq throttle)
    - **Worker**: `scheduleAnomalyAlerts()` — 30 dəqiqəlik interval, 5 dəqiqə gecikmə, `unref()`; `FRONTEND_ONLY` rejimində işləmir
    - **UI**: `/stats-page/:short` → “Anomaliyalar” paneli son 30 günün siqnallarını və hədəf sağlamlığını göstərir (`GET /api/stats/:short/anomalies`)
    - **Sxem**: `urls.last_health_status`, `urls.last_health_checked_at`, `urls.last_health_error`
    - **Testlər**: `test/anomaly-alerts.test.js` (AL-01 … AL-07)
14. ✅ **Agentlik (workspace) rollup** — `src/lib/workspace-stats.js`
    - `GET /api/workspaces/:id/stats?days=7|30|90|365` — üzvlük + Pro yoxlaması, `member` rolu kifayətdir
    - Klik/unikal/bot/konversiya, dönüş nisbəti, əvvəlki dövrlə Δ%, günlük seriya, top 10 link, mənbə, cihaz, goal-lar — hamısı SQL aqreqasiyası (JS-ə yalnız kiçik sətirlər düşür)
    - Workspace yalnız öz linklərini sayır (`urls.workspace_id`) — fərdi linklər sızmır
    - **UI**: `/workspaces` detal kartı — 7/30/90 seçicisi, 4 KPI + Δ%, top linklər və mənbələr siyahısı
    - **Testlər**: `test/workspace-stats.test.js` (WS-STAT-01 … 03)

---

## Metrikalar (biznes baxımından)

| Metrika | Mənbə | Status |
|---|---|---|
| Klik | `link_stats_daily.clicks` | ✅ |
| Unikal ziyarətçi | `click_uniques` (gündə 1 dəfə ip_hash) | ✅ |
| Bot / insan | `clicks.is_bot` | ✅ |
| Mənbə (referrer) | `clicks.referrer_host` | ✅ |
| UTM (source/medium/campaign) | `clicks.utm_*` | ✅ |
| Cihaz | `clicks.device_type` | ✅ |
| Coğrafiya | `clicks.country/city` | ✅ |
| A/B variantı | `clicks.variant` | ✅ |
| Konversiya | `link_conversions` + rollup `conversions` | ✅ |
| Dövr müqayisəsi (Δ%) | iki aralıq sorğusu | ✅ |
| Anomaliya siqnalı | `src/lib/anomaly-alerts.js` | ✅ |
| Hədəf sağlamlığı | `urls.last_health_*` | ✅ |
| Workspace rollup | `src/lib/workspace-stats.js` | ✅ |

---

## Texniki qərarlar

- **Raw IP saxlanmır**: yalnız `ip_hash` (HMAC-SHA256, mövcud `hashIpForStorage`).
- **Consent**: `essential` rejimində atribut, şəhər və hash yazılmır — yalnız sayğac.
- **Rollup**: hər klikdə `link_stats_daily` upsert (klik+1, unikal+0/1, bot+0/1).
- **Xarici yoxlama**: hədəf sağlamlığı sorğusu pinned IP + bloklanmış port/IP siyahıları ilə gedir, redirect izlənmir, cavab gövdəsi oxunmur.
- **Anomaliya hədləri**: `ANOMALY_SPIKE_MULTIPLIER`, `ANOMALY_SPIKE_MIN_CLICKS`, `ANOMALY_DROP_MULTIPLIER`, `ANOMALY_DROP_MIN_BASELINE`, `ANOMALY_HEALTH_CHECKS=0` (söndürmək üçün).
- **Aqreqasiya SQL-də**: `(url_id, click_time)` indeksi üzərində `GROUP BY`, JS-ə yalnız top-12 sətir.
- **Raw klik limiti**: default 2000, maksimum 5000 — cavab ölçüsü məhduddur.
- **Retention** (növbəti): raw kliklər 90 gün (Pro 365), rollup əbədi.

---

## Yoxlama qaydaları

- `npm test` (PostgreSQL tələb edən testlər DB yoxdursa skip olunur)
- `node --check` — dəyişdirilmiş bütün `.js` fayllar
- Statik yoxlama (bu mühitdə Node yoxdur): brace/regex parser + EJS `<script>` bloklarının ayrıca yoxlanması
- UI dəyişiklikləri brauzerdə əl ilə yoxlanmalıdır (`/stats-page/:short`)

### Statik yoxlama nəticəsi (son tur)

| Yoxlama | Nəticə |
|---|---|
| `src/lib/link-stats.js`, `src/routes/api/*.js`, `src/lib/analytics.js`, `src/lib/stats-report.js`, `src/db/migrate.js` | ✅ brace/regex balansı |
| `views/stats-page.ejs` inline `<script>` (5 blok) | ✅ (nested template literal olan blok əl ilə yoxlanılır — parser məhdudiyyəti) |
| `public/lang.js` | ✅ balans + az/tr/en parity |
| Yeni DDL (`link_stats_daily`, `click_uniques`, `link_conversions`, `stats_shares`, `campaigns`, `urls.last_health_*`) | ✅ `sqlite3` ilə real SQL parse |
| Anomaliya/workspace sorğuları (9 sorğu) | ✅ `sqlite3` ilə işə salındı, workspace sərhədi yoxlanıldı |
| SQL placeholder ↔ parametr cütlüyü (yeni 15 sorğu) | ✅ əl ilə yoxlanıldı |

---

## Tapılmış və düzəldilmiş xətalar (bug hunt)

| # | Ciddilik | Problem | Düzəliş |
|---|---|---|---|
| 1 | **Kritik** | `loadLinkStats` `rangeStartIso` dəyişənini elan etmədən istifadə edirdi (`win`-dən destructure olunmamışdı) → `ReferenceError` → `/api/stats/:short`, Pro API, CSV export, paylaşım və embed hamısı **500** qaytarırdı | dəyişən destructure olundu; goal sorğusu `created_at` əvəzinə rollup `day` sütunu ilə filtrlənir |
| 2 | Orta | Paylaşılan hesabat səhifəsi `days` pəncərəsi ilə məhdud olsa da **bütün vaxtın** rəqəmlərini göstərirdi | KPI-lər `total_clicks` və `uniques_range` ilə hesablanır |
| 3 | Orta | Konversiya pikseli bot/avtomatik sorğuları da konversiya kimi sayırdı | UA bot yoxlaması əlavə edildi (piksel yenə 200 qaytarır) |
| 4 | Orta (məxfilik) | Piksel `essential` razılığında da IP hash (pseudonim identifikator) saxlayırdı | `essential` rejimində anonim açar istifadə olunur; sayğac qalır, identifikator yazılmır |
| 5 | Aşağı | `probeDestination` — socket `close` hadisəsi uğurlu cavabdan sonra da "nasaz" nəticə verə bilərdi | `gotResponse` qoruyucusu: yalnız status sətri gəlməzdən əvvəl bağlanma nasazlıq sayılır |
| 6 | Aşağı (məxfilik) | `/embed/:short` cavabı `Cache-Control: public` idi — paylaşılan keşlər özəl statistikası saxluya bilərdi | `private, max-age=300` |
| 7 | Orta (UI) | `views/updates.ejs` "Entry 16" bağlanmamışdı (`</ul></div></article>` yox) — sonrakı qeyd kartın içində görünürdü | bağlayıcı teqlər əlavə edildi, HTML balansı yoxlanıldı |
| 8 | Test | `AN-03` `localhost` referrer-ini gözləyirdi (kod onu self-traffic kimi bloklayır); `AN-08/2` rollup yazısı ilə yarışırdı (flaky) | gözlənti düzəldildi, rollup üçün polling; yeni `AN-11` (bot konversiya) və `AN-12` (stats servisi hemişə cavab qaytarır) regresiya testləri |

Yoxlama: bütün dəyişikliklər `sqlite3` sxem/sorğu yoxlaması, brace/regex parser və HTML balans yoxlamasından keçdi. `npm test` bu mühitdə (Node.js yoxdur) icra olunmur.

---

## Bug hunt v2 — tapılan və düzəldilən problemlər

| # | Ciddilik | Problem | Düzəliş |
|---|---|---|---|
| 1 | **Kritik** | Link silinməsi: `clicks`, `link_stats_daily`, `click_uniques`, `link_conversions`, `stats_shares`, `link_funnel_steps` cədvəllərindəki FK-lər `ON DELETE CASCADE` deyil — analitikası olan hər link üçün `DELETE FROM urls` foreign-key xətası verirdi | `src/lib/link-purge.js` + 3 silmə yolunda (tək, toplu, admin) tranzaksiya daxilində əvvəlcə analitika sətirləri silinir; `test/link-purge.test.js` |
| 2 | Yüksək (məntiq) | Funnel pilləsi yalnız goal yazısı **yeni** olduqda yazılırdı; eyni ziyarətçi eyni gün step 1→2 keçəndə goal dedupe bloklayırdı | Pillə yazısı goal insert-dən **əvvəl** aparılır |
| 3 | Orta | `visitors` mövcud olmayanda (essential consent/legacy) funnel bütün pillələri 0% göstərirdi | Baza kimi step-1 ziyarətçi sayı istifadə olunur |
| 4 | Orta (performans) | A/B klik sorğusu `SUBSTR(click_time,1,10) >= ?` ilə indeksi sıradan çıxarırdı | `click_time >= ?` aralığı (`idx_clicks_url_time`) |
| 5 | Orta (performans) | Konversiya variantının tapılması `SUBSTR(...) = day` ilə geniş skan edirdi | `click_time >= ? AND < ?` (`idx_clicks_url_ip`) |
| 6 | Aşağı (düzgünlük) | Pro API `q` filtri `_`/`%` simvollarını `LIKE` wildcard kimi qəbul edirdi | `ESCAPE '\\'` ilə escape |
| 7 | Orta (məxfilik) | `/api/stats/:short/audit` cavabı `ip_hash` qaytarırdı | `ip_hash` seçilmir, yalnız action/time/user/api_key |
| 8 | Orta (avtorizasiya) | Workspace üzvü link-in alert hədlərini dəyişə bilirdi (sahibin bildirişlərinə təsir) | PATCH/DELETE yalnız link sahibine (403); oxumaq üzvlərə açıq |
| 9 | Orta (resurs) | `link_funnel_steps` cədvəli limitsiz böyüyürdü | Gündəlik retention worker (180 gün, 2000-lik batch) |
| 10 | Aşağı (UI) | Range dəyişdikdə funnel/visitors/A-B panelləri köhnə pəncərəni göstərirdi | Range dəyişikliyində `loadExtras()` yenidən çağırılır |

---

## Dalğa 2 (v2) — tətbiq olundu

İkinci dalğa `loadLinkStats` payload-ını **dəyişmədən** ayrı endpoint-lərlə gətirilir; redirect/consent/CSRF hot-path toxunulmayıb.

| Imkan | Endpoint / fayl | Yazı mənbəyi |
|---|---|---|
| F2 Çoxpilləli funnel | `GET /api/stats/:short/funnel`, `src/lib/funnel.js`, `link_funnel_steps` | piksel `&step=` (`recordConversion`) |
| F3 Alert hədləri | `GET/PATCH /api/user/alert-thresholds`, `GET/PATCH/DELETE /api/stats/:short/alert-thresholds`, `src/lib/alert-thresholds.js` | `users.alert_*`, `link_alert_settings` |
| F4 Kampaniya hədəfi | `goal_progress` payload-ı, PATCH `goal_clicks/goal_conversions` | `campaigns.goal_*` |
| F5 UTM builder | `src/lib/utm.js`, hər iki shorten marşrutu + Pro API `utm` obyekti | kvər istəyi (yaradılış anı) |
| F6 Yeni vs qayıdan | `GET /api/stats/:short/visitors`, `src/lib/visitor-split.js` | `click_uniques` oxuması |
| F7 A/B əhəmiyyəti | `GET /api/stats/:short/ab-significance`, `src/lib/ab-significance.js` | `clicks.variant`, `link_conversions.variant` |
| F8 Canlı lent | `GET /api/stats/:short/live?after_id=` (polling, SSE yox) | `clicks` (yalnız id/son 25 sətir) |
| F9 Geo xəritə | `public/world-map.json` + `public/stats-map.js` | mövcud `countries` payload-ı |
| F10 Seqmentlər | `src/routes/api/segments.js`, `saved_segments` | istifadəçi CRUD |
| F11 Pro API v1 | `src/routes/api/pro-v1.js` (`/links`, `/campaigns`, `/openapi.json`) | oxuma |
| F12 Audit jurnalı | `src/lib/analytics-audit.js`, `GET /api/stats/:short/audit` | baxış/export/paylaşım hadisələri (dedupe + buffer) |

**Yeni sxem:** `link_funnel_steps`, `link_alert_settings`, `saved_segments`, `analytics_audit_log`, `link_conversions.variant`, `campaigns.goal_*`, `users.alert_*`. İndekslər: `idx_click_uniques_url_ip`, `idx_clicks_url_ip`, `idx_urls_user_created_id`.

**Prinsiplər:** `INSERT OR IGNORE` yox — hər yazı `ON CONFLICT`; SSE yox (Netlify serverless) — polling; yeni Pro scope yox — `account:read`; `link-stats.js` toxunulmaz.

**Testlər:** `test/analytics-extras.test.js` (saf), `test/analytics-v2.test.js` (DB), `test/pro-api-v1.test.js`, `test/geo-map.test.js`, `test/i18n-parity.test.js`.

---

## Risklər

- Köhnə linklərdə `ip_hash` yoxdur → `uniques_available:false`, UI "—" göstərir.
- `total_clicks` artıq seçilmiş aralığa aiddir; bütün vaxt üçün `clicks_total` istifadə olunur.
- Rollup yazılışı fire-and-forget: proses çökərsə son klik itə bilər (redirect bloklanmır).
