/* Ovlink campaign workflow — cached client-side controller. */
(function () {
      var I18N = {
        az: {
          campaigns_title: 'Kampaniyalar',
          campaigns_sub: 'Linkləri kampaniyalar üzrə qruplaşdırın və nəticəni bir ekranda görün.',
          campaigns_back_dashboard: 'İdarə paneli',
          campaigns_name_placeholder: 'Kampaniya adı (məs: Yay Satışı)',
          campaigns_goal_placeholder: 'Konversiya hədəfi (məs: signup)',
          campaigns_create: 'Yarat',
          campaigns_col_name: 'Kampaniya',
          campaigns_col_links: 'Link',
          campaigns_col_clicks: 'Klik',
          campaigns_col_uniques: 'Unikal',
          campaigns_col_conversions: 'Konv.',
          campaigns_empty: 'Hələ kampaniya yoxdur.',
          campaigns_name_label: 'Kampaniya adı',
          campaigns_goal_label: 'Konversiya hədəfi',
          campaigns_list_title: 'Kampaniyalarım',
          campaigns_period: 'Son 30 günün nəticələri',
          campaigns_refresh: 'Yenilə',
          campaigns_export_csv: 'CSV hesabatı endir',
          campaigns_export_error: 'Hesabat endirilə bilmədi. Yenidən cəhd edin.',
          campaigns_loading: 'Kampaniyalar yüklənir…',
          campaigns_empty_title: 'İlk kampaniyanızı yaradın',
          campaigns_empty_desc: 'Linkləri və nəticələri bir məqsəd altında izləməyə başlayın.',
          campaigns_empty_cta: 'Kampaniya yarat',
          campaigns_load_error: 'Kampaniyaları yükləmək mümkün olmadı.',
          campaigns_retry: 'Yenidən yoxla',
          campaigns_back: '← Geri',
          campaigns_kpi_clicks: 'Klik',
          campaigns_kpi_uniques: 'Unikal',
          campaigns_kpi_conversions: 'Konversiya',
          campaigns_kpi_rate: 'Konversiya faizi',
          campaigns_goal_clicks: 'Klik hədəfi',
          campaigns_goal_conversions: 'Konversiya hədəfi',
          campaigns_goal_save: 'Hədəfi saxla',
          campaigns_goal_saved: 'Hədəf saxlanıldı.',
          campaigns_top_links: 'Top linklər',
          campaigns_sources: 'Mənbələr',
          campaigns_goals: 'Hədəflər',
          campaigns_created: 'Kampaniya yaradıldı.',
          campaigns_deleted: 'Silindi.',
          campaigns_name_invalid: 'Ad ən az 2 simvol olmalıdır.'
        },
        tr: {
          campaigns_title: 'Kampanyalar',
          campaigns_sub: 'Linkleri kampanyalar altında gruplayın ve sonucu tek ekranda görün.',
          campaigns_back_dashboard: 'Kontrol paneli',
          campaigns_name_placeholder: 'Kampanya adı (örn: Yaz Satışı)',
          campaigns_goal_placeholder: 'Dönüşüm hedefi (örn: signup)',
          campaigns_create: 'Oluştur',
          campaigns_col_name: 'Kampanya',
          campaigns_col_links: 'Link',
          campaigns_col_clicks: 'Tıklama',
          campaigns_col_uniques: 'Tekil',
          campaigns_col_conversions: 'Dön.',
          campaigns_empty: 'Henüz kampanya yok.',
          campaigns_name_label: 'Kampanya adı',
          campaigns_goal_label: 'Dönüşüm hedefi',
          campaigns_list_title: 'Kampanyalarım',
          campaigns_period: 'Son 30 günün sonuçları',
          campaigns_refresh: 'Yenile',
          campaigns_export_csv: 'CSV raporu indir',
          campaigns_export_error: 'Rapor indirilemedi. Tekrar deneyin.',
          campaigns_loading: 'Kampanyalar yükleniyor…',
          campaigns_empty_title: 'İlk kampanyanızı oluşturun',
          campaigns_empty_desc: 'Bağlantıları ve sonuçları tek bir hedef altında izleyin.',
          campaigns_empty_cta: 'Kampanya oluştur',
          campaigns_load_error: 'Kampanyalar yüklenemedi.',
          campaigns_retry: 'Tekrar dene',
          campaigns_back: '← Geri',
          campaigns_kpi_clicks: 'Tıklama',
          campaigns_kpi_uniques: 'Tekil ziyaretçi',
          campaigns_kpi_conversions: 'Dönüşüm',
          campaigns_kpi_rate: 'Dönüşüm oranı',
          campaigns_goal_clicks: 'Tıklama hedefi',
          campaigns_goal_conversions: 'Dönüşüm hedefi',
          campaigns_goal_save: 'Hedefi kaydet',
          campaigns_goal_saved: 'Hedef kaydedildi.',
          campaigns_top_links: 'En iyi linkler',
          campaigns_sources: 'Kaynaklar',
          campaigns_goals: 'Hedefler',
          campaigns_created: 'Kampanya oluşturuldu.',
          campaigns_deleted: 'Silindi.',
          campaigns_name_invalid: 'Ad en az 2 karakter olmalıdır.'
        },
        en: {
          campaigns_title: 'Campaigns',
          campaigns_sub: 'Group links into campaigns and read the result on one screen.',
          campaigns_back_dashboard: 'Dashboard',
          campaigns_name_placeholder: 'Campaign name (e.g. Summer Sale)',
          campaigns_goal_placeholder: 'Conversion goal (e.g. signup)',
          campaigns_create: 'Create',
          campaigns_col_name: 'Campaign',
          campaigns_col_links: 'Links',
          campaigns_col_clicks: 'Clicks',
          campaigns_col_uniques: 'Uniques',
          campaigns_col_conversions: 'Conv.',
          campaigns_empty: 'No campaigns yet.',
          campaigns_name_label: 'Campaign name',
          campaigns_goal_label: 'Conversion goal',
          campaigns_list_title: 'My campaigns',
          campaigns_period: 'Results for the last 30 days',
          campaigns_refresh: 'Refresh',
          campaigns_export_csv: 'Download CSV report',
          campaigns_export_error: 'Could not download report. Please try again.',
          campaigns_loading: 'Loading campaigns…',
          campaigns_empty_title: 'Create your first campaign',
          campaigns_empty_desc: 'Track links and results together under one goal.',
          campaigns_empty_cta: 'Create campaign',
          campaigns_load_error: 'Could not load campaigns.',
          campaigns_retry: 'Try again',
          campaigns_back: '← Back',
          campaigns_kpi_clicks: 'Clicks',
          campaigns_kpi_uniques: 'Unique visitors',
          campaigns_kpi_conversions: 'Conversions',
          campaigns_kpi_rate: 'Conversion rate',
          campaigns_goal_clicks: 'Click goal',
          campaigns_goal_conversions: 'Conversion goal',
          campaigns_goal_save: 'Save goal',
          campaigns_goal_saved: 'Goal saved.',
          campaigns_top_links: 'Top links',
          campaigns_sources: 'Sources',
          campaigns_goals: 'Goals',
          campaigns_created: 'Campaign created.',
          campaigns_deleted: 'Deleted.',
          campaigns_name_invalid: 'Name must be at least 2 characters.'
        }
      };
      var L = I18N[(document.documentElement.lang || 'az').slice(0, 2)] || I18N.az;

      function applyLabels() {
        document.querySelectorAll('[data-i18n]').forEach(function (el) {
          var key = el.getAttribute('data-i18n');
          if (L[key]) el.textContent = L[key];
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
          var key = el.getAttribute('data-i18n-placeholder');
          if (L[key]) el.placeholder = L[key];
        });
      }

      var CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
      var chart = null;
      var currentCampaignId = null;
      var currentCampaignSnapshot = null;

      function $(id) { return document.getElementById(id); }
      function text(id, value) { var el = $(id); if (el) el.textContent = value; }
      function num(value) { return Number(value || 0).toLocaleString(); }

      function setMsg(message, isError) {
        var el = $('createMsg');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'cp-msg' + (message ? (isError ? ' cp-msg--err' : ' cp-msg--ok') : '');
      }

      function request(method, url, body) {
        return fetch(url, {
          method: method,
          credentials: 'include',
          headers: Object.assign(
            { 'Accept': 'application/json' },
            body ? { 'Content-Type': 'application/json', 'x-csrf-token': CSRF } : {}
          ),
          body: body ? JSON.stringify(body) : undefined,
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            return data;
          });
        });
      }

      function renderList(campaigns) {
        var container = $('campaignList');
        if (!container) return;
        container.textContent = '';

        if (!campaigns || !campaigns.length) {
          var empty = document.createElement('div');
          empty.className = 'cp-empty-state';
          var icon = document.createElement('i');
          icon.className = 'fa-solid fa-layer-group';
          icon.setAttribute('aria-hidden', 'true');
          var title = document.createElement('h3');
          title.textContent = L.campaigns_empty_title;
          var description = document.createElement('p');
          description.textContent = L.campaigns_empty_desc;
          var action = document.createElement('button');
          action.type = 'button';
          action.className = 'cp-btn';
          action.textContent = L.campaigns_empty_cta;
          action.addEventListener('click', function () { $('campaignName').focus(); });
          empty.appendChild(icon);
          empty.appendChild(title);
          empty.appendChild(description);
          empty.appendChild(action);
          container.appendChild(empty);
          return;
        }

        campaigns.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'cp-row';

          var nameCell = document.createElement('div');
          var name = document.createElement('div');
          name.className = 'cp-name';
          name.textContent = item.name;
          var slug = document.createElement('div');
          slug.className = 'cp-slug';
          slug.textContent = '/' + item.slug;
          nameCell.appendChild(name);
          nameCell.appendChild(slug);
          row.appendChild(nameCell);

          [
            { value: item.links_count, hideSmall: false },
            { value: item.clicks, hideSmall: false },
            { value: item.uniques, hideSmall: true },
            { value: item.conversions, hideSmall: true },
          ].forEach(function (cell) {
            var el = document.createElement('div');
            el.className = 'cp-num' + (cell.hideSmall ? ' cp-hide-sm' : '');
            el.textContent = num(cell.value);
            row.appendChild(el);
          });

          var actions = document.createElement('div');
          actions.className = 'cp-actions';

          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'cp-btn cp-btn--ghost';
          openBtn.textContent = '→';
          openBtn.setAttribute('aria-label', item.name);
          openBtn.addEventListener('click', function () { openCampaign(item.id); });

          var deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'cp-btn cp-btn--danger';
          deleteBtn.textContent = '×';
          deleteBtn.setAttribute('aria-label', 'delete');
          deleteBtn.addEventListener('click', function () { removeCampaign(item.id, item.name); });

          actions.appendChild(openBtn);
          actions.appendChild(deleteBtn);
          row.appendChild(actions);
          container.appendChild(row);
        });
      }

      function renderItems(containerId, entries, formatter) {
        var container = $(containerId);
        if (!container) return;
        container.textContent = '';
        var list = (entries || []).slice(0, 6);
        if (!list.length) {
          var empty = document.createElement('div');
          empty.className = 'cp-empty';
          empty.textContent = '—';
          container.appendChild(empty);
          return;
        }
        list.forEach(function (entry) {
          var row = document.createElement('div');
          row.className = 'cp-item';
          var label = document.createElement('span');
          label.textContent = formatter ? formatter(entry) : (entry.name || '—');
          var value = document.createElement('b');
          value.textContent = num(entry.count);
          row.appendChild(label);
          row.appendChild(value);
          container.appendChild(row);
        });
      }

      function renderGoalProgress(progress) {
        var container = $('detailGoals');
        if (!container) return;
        container.textContent = '';
        if (!progress) return;
        [
          { key: 'clicks', label: L.campaigns_goal_clicks },
          { key: 'conversions', label: L.campaigns_goal_conversions },
        ].forEach(function (entry) {
          var item = progress[entry.key];
          if (!item || !item.target) return;
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12px;';
          var label = document.createElement('span');
          label.textContent = entry.label + ': ' + num(item.actual) + ' / ' + num(item.target) + ' · ' + Number(item.percent || 0) + '%';
          var bar = document.createElement('div');
          bar.style.cssText = 'height:5px;border-radius:100px;background:rgba(127,127,127,0.2);overflow:hidden;';
          var fill = document.createElement('div');
          fill.style.cssText = 'height:100%;border-radius:100px;background:' + (item.achieved ? '#34d399' : 'rgba(255,255,255,0.6)') + ';';
          fill.style.width = Math.max(2, Number(item.bar_percent || 0)) + '%';
          bar.appendChild(fill);
          row.appendChild(label);
          row.appendChild(bar);
          container.appendChild(row);
        });
      }

      function drawChart(series) {
        var canvas = $('campaignChart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (chart) { chart.destroy(); chart = null; }

        chart = new Chart(canvas, {
          type: 'line',
          data: {
            labels: (series || []).map(function (point) { return point.date.slice(5); }),
            datasets: [{
              data: (series || []).map(function (point) { return point.count; }),
              borderColor: '#ffffff',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.3,
              fill: true,
              backgroundColor: 'rgba(255,255,255,0.06)'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#71717a', maxTicksLimit: 8 } },
              y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#71717a', precision: 0 } }
            }
          }
        });
      }

      var listGeneration = 0;
      function setListStatus(message, state) {
        var element = $('campaignListStatus');
        if (element) { element.textContent = message || ''; element.dataset.state = state || ''; }
      }
      function loadList() {
        var generation = ++listGeneration;
        var refresh = $('campaignRefresh');
        if (refresh) refresh.disabled = true;
        setListStatus(L.campaigns_loading, 'loading');
        return request('GET', '/api/campaigns?days=30')
          .then(function (data) {
            if (generation !== listGeneration) return;
            renderList(data.campaigns || []);
            setListStatus('', 'done');
          })
          .catch(function () {
            if (generation !== listGeneration) return;
            setListStatus(L.campaigns_load_error, 'error');
            var container = $('campaignList');
            if (!container) return;
            container.textContent = '';
            var retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'cp-btn cp-btn--ghost';
            retry.textContent = L.campaigns_retry;
            retry.addEventListener('click', loadList);
            container.appendChild(retry);
          })
          .finally(function () { if (generation === listGeneration && refresh) refresh.disabled = false; });
      }
      var refreshButton = $('campaignRefresh');
      if (refreshButton) refreshButton.addEventListener('click', loadList);

      function openCampaign(id) {
        currentCampaignId = id;
        currentCampaignSnapshot = null;
        if ($('campaignExportCsv')) $('campaignExportCsv').disabled = true;
        $('listSection').hidden = true;
        $('detailSection').hidden = false;

        request('GET', '/api/campaigns/' + encodeURIComponent(id) + '?days=30')
          .then(function (data) {
            if (currentCampaignId !== id || $('detailSection').hidden) return;
            currentCampaignSnapshot = data;
            if ($('campaignExportCsv')) $('campaignExportCsv').disabled = false;
            text('detailName', data.campaign.name);
            text('detailMeta', '/' + data.campaign.slug + ' · ' + data.links_count + ' link · ' + data.range.days + 'g');
            text('kClicks', num(data.clicks));
            text('kUniques', num(data.uniques));
            text('kConversions', num(data.conversions));
            text('kRate', Number(data.conversion_rate || 0) + '%');
            renderGoalProgress(data.goal_progress);

            var goalClicksInput = $('goalClicksInput');
            var goalConversionsInput = $('goalConversionsInput');
            if (goalClicksInput) goalClicksInput.value = data.campaign.goal_clicks || '';
            if (goalConversionsInput) goalConversionsInput.value = data.campaign.goal_conversions || '';

            renderItems('topLinks', (data.top_links || []).map(function (link) {
              return { name: '/' + link.short, count: link.clicks };
            }));
            renderItems('topSources', data.top_sources);
            renderItems('topGoals', data.top_goals);
            drawChart(data.clicks_by_day);
          })
          .catch(function (err) {
            if (currentCampaignId !== id || $('detailSection').hidden) return;
            text('detailName', '—');
            setMsg(err.message, true);
          });
      }

      var exportButton = $('campaignExportCsv');
      if (exportButton) exportButton.addEventListener('click', function () {
        if (!currentCampaignSnapshot || !currentCampaignId || !window.OvlinkCampaignReport) return;
        var requestedCampaignId = currentCampaignId;
        var requestedSnapshot = currentCampaignSnapshot;
        exportButton.disabled = true;
        fetch('/api/campaigns/' + encodeURIComponent(requestedCampaignId) + '/export.csv?days=30', {
          credentials: 'same-origin', headers: { Accept: 'text/csv' }
        })
          .then(function (response) {
            if (!response.ok) throw new Error(L.campaigns_export_error);
            return response.blob();
          })
          .then(function (blob) {
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = window.OvlinkCampaignReport.filename(requestedSnapshot);
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          })
          .catch(function (error) {
            if (requestedCampaignId === currentCampaignId) setMsg(error.message, true);
          })
          .finally(function () {
            if (requestedCampaignId === currentCampaignId) exportButton.disabled = false;
          });
      });

      var goalSaveBtn = $('goalSaveBtn');
      if (goalSaveBtn) {
        goalSaveBtn.addEventListener('click', function () {
          if (!currentCampaignId) return;
          var goalMsg = $('goalMsg');
          var payload = {
            goal_clicks: $('goalClicksInput') ? $('goalClicksInput').value : '',
            goal_conversions: $('goalConversionsInput') ? $('goalConversionsInput').value : '',
          };
          request('PATCH', '/api/campaigns/' + encodeURIComponent(currentCampaignId), payload)
            .then(function () {
              if (goalMsg) { goalMsg.textContent = L.campaigns_goal_saved || 'OK'; goalMsg.className = 'cp-msg cp-msg--ok'; }
              openCampaign(currentCampaignId);
            })
            .catch(function (err) {
              if (goalMsg) { goalMsg.textContent = err.message; goalMsg.className = 'cp-msg cp-msg--err'; }
            });
        });
      }

      function removeCampaign(id, name) {
        if (!window.confirm('“' + name + '” silinsin? Linklər silinmir.')) return;
        request('DELETE', '/api/campaigns/' + encodeURIComponent(id))
          .then(function () { setMsg(L.campaigns_deleted || 'Silindi.', false); return loadList(); })
          .catch(function (err) { setMsg(err.message, true); });
      }

      var form = $('createForm');
      if (form) {
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          var name = ($('campaignName') && $('campaignName').value || '').trim();
          var goal = ($('campaignGoal') && $('campaignGoal').value || '').trim();
          if (name.length < 2) { setMsg(L.campaigns_name_invalid || 'Ad ən az 2 simvol olmalıdır.', true); return; }

          var btn = $('createBtn');
          if (btn) btn.disabled = true;
          request('POST', '/api/campaigns', { name: name, goal: goal })
            .then(function () {
              setMsg(L.campaigns_created || 'Kampaniya yaradıldı.', false);
              form.reset();
              return loadList();
            })
            .catch(function (err) { setMsg(err.message, true); })
            .then(function () { if (btn) btn.disabled = false; });
        });
      }

      var backBtn = $('backBtn');
      if (backBtn) {
        backBtn.addEventListener('click', function () {
          currentCampaignId = null;
          currentCampaignSnapshot = null;
          $('detailSection').hidden = true;
          $('listSection').hidden = false;
          loadList();
        });
      }

      applyLabels();
      loadList();
    })();
