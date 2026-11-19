/* Ovlink P16 Campaign Launch Wizard — 5-step Monolith-aligned client controller */
(function () {
  var STORAGE_KEY = 'ovlink_campaign_wizard_draft_v1';
  var I18N = {
    az: {
      cw_open_btn: 'Kampaniya Wizard',
      cw_close_btn: 'Bağla',
      cw_title: 'Kampaniya Başlatma Wizard-ı',
      cw_sub: '5 addımda səhvsiz kampaniya, UTM linklər və dinamik QR yaradın.',
      cw_resume_text: 'Yarımçıq kampaniya draft-ı tapıldı.',
      cw_resume_btn: 'Davam et',
      cw_discard_btn: 'Təmizlə',
      cw_autosaved: 'Draft avtomatik saxlanıldı',
      cw_step_1: '1. Məqsəd',
      cw_step_2: '2. Kanallar',
      cw_step_3: '3. Linklər',
      cw_step_4: '4. Önbaxış',
      cw_step_5: '5. Təsdiq',
      cw_next: 'Növbəti addım →',
      cw_prev: '← Əvvəlki',
      cw_launch: 'Kampaniyanı başlat',
      cw_launching: 'Yaradılır…',
      cw_hint_1: 'Kampaniya adı, hədəfi və istəyə bağlı büdcəni daxil edin.',
      cw_hint_2: 'Bu kampaniyada istifadə edəcəyiniz kanalları seçin.',
      cw_hint_3: 'Hər kanal üçün hədəf URL əlavə edin; QR lazım olanları işarələyin.',
      cw_hint_4: 'UTM etiketli linkləri yoxlayın — hələ heç nə yazılmayıb.',
      cw_hint_5: 'Nəticə və yaradılan aktivlərin xülasəsi.',
      cw_err_name: 'Kampaniya adı ən az 2 simvol olmalıdır.',
      cw_err_channels: 'Ən azı 1 kanal seçin.',
      cw_err_links: 'Ən azı 1 keçərli https:// URL daxil edin.',
      cw_ok_completed: 'Kampaniya və bütün aktivlər uğurla yaradıldı.',
      cw_ok_partial: 'Kampaniya yaradıldı, lakin bəzi aktivlər uğursuz oldu (aşağıda göstərilib).',
      cw_add_link: '+ Link əlavə et',
      cw_qr_label: 'QR yarat',
      cw_done_refresh: 'Siyahını yenilə',
    },
    tr: {
      cw_open_btn: 'Kampanya Sihirbazı',
      cw_close_btn: 'Kapat',
      cw_title: 'Kampanya Başlatma Sihirbazı',
      cw_sub: '5 adımda hatasız kampanya, UTM linkler ve dinamik QR oluşturun.',
      cw_resume_text: 'Yarım kalan kampanya taslağı bulundu.',
      cw_resume_btn: 'Devam et',
      cw_discard_btn: 'Temizle',
      cw_autosaved: 'Taslak otomatik kaydedildi',
      cw_step_1: '1. Hedef',
      cw_step_2: '2. Kanallar',
      cw_step_3: '3. Linkler',
      cw_step_4: '4. Önizleme',
      cw_step_5: '5. Onay',
      cw_next: 'Sonraki adım →',
      cw_prev: '← Önceki',
      cw_launch: 'Kampanyayı başlat',
      cw_launching: 'Oluşturuluyor…',
      cw_hint_1: 'Kampanya adı, hedefi ve isteğe bağlı bütçeyi girin.',
      cw_hint_2: 'Bu kampanyada kullanacağınız kanalları seçin.',
      cw_hint_3: 'Her kanal için hedef URL ekleyin; QR gerekenleri işaretleyin.',
      cw_hint_4: 'UTM etiketli linkleri kontrol edin — henüz kayıt yapılmadı.',
      cw_hint_5: 'Sonuç ve oluşturulan varlık özeti.',
      cw_err_name: 'Kampanya adı en az 2 karakter olmalıdır.',
      cw_err_channels: 'En az 1 kanal seçin.',
      cw_err_links: 'En az 1 geçerli https:// URL girin.',
      cw_ok_completed: 'Kampanya ve tüm varlıklar başarıyla oluşturuldu.',
      cw_ok_partial: 'Kampanya oluşturuldu, ancak bazı varlıklar başarısız oldu.',
      cw_add_link: '+ Link ekle',
      cw_qr_label: 'QR oluştur',
      cw_done_refresh: 'Listeyi yenile',
    },
    en: {
      cw_open_btn: 'Launch Wizard',
      cw_close_btn: 'Close',
      cw_title: 'Campaign Launch Wizard',
      cw_sub: 'Build a campaign, UTM links, and dynamic QR assets in 5 guided steps.',
      cw_resume_text: 'Unfinished campaign draft found.',
      cw_resume_btn: 'Resume',
      cw_discard_btn: 'Discard',
      cw_autosaved: 'Draft autosaved',
      cw_step_1: '1. Goal',
      cw_step_2: '2. Channels',
      cw_step_3: '3. Links',
      cw_step_4: '4. Preview',
      cw_step_5: '5. Launch',
      cw_next: 'Next step →',
      cw_prev: '← Back',
      cw_launch: 'Launch campaign',
      cw_launching: 'Launching…',
      cw_hint_1: 'Enter the campaign name, goal, and optional budget.',
      cw_hint_2: 'Select the channels you plan to publish on.',
      cw_hint_3: 'Add destination URLs per channel and toggle dynamic QR where needed.',
      cw_hint_4: 'Review UTM-tagged URLs before any records are written.',
      cw_hint_5: 'Launch summary and per-asset status.',
      cw_err_name: 'Campaign name must be at least 2 characters.',
      cw_err_channels: 'Select at least 1 channel.',
      cw_err_links: 'Add at least 1 valid https:// URL.',
      cw_ok_completed: 'Campaign and all assets launched.',
      cw_ok_partial: 'Campaign created with partial asset failures (see details below).',
      cw_add_link: '+ Add link',
      cw_qr_label: 'Create QR',
      cw_done_refresh: 'Refresh list',
    },
  };

  var lang = (document.documentElement.lang || 'az').slice(0, 2);
  var L = I18N[lang] || I18N.az;
  var CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var CHANNELS = ['instagram', 'whatsapp', 'telegram', 'facebook', 'tiktok', 'email', 'print_qr', 'web'];

  function $(id) { return document.getElementById(id); }

  var state = {
    step: 1,
    name: '',
    goal: '',
    status: 'active',
    budget_amount: '',
    budget_currency: 'AZN',
    channels: ['instagram', 'whatsapp'],
    links: [{ channel: 'instagram', url: '', generate_qr: false }],
    preview: null,
    result: null,
  };

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        step: state.step < 5 ? state.step : 4,
        updatedAt: new Date().toISOString(),
        data: {
          name: state.name,
          goal: state.goal,
          status: state.status,
          budget_amount: state.budget_amount,
          budget_currency: state.budget_currency,
          channels: state.channels,
          links: state.links,
        },
      }));
      var statusEl = $('cwAutosave');
      if (statusEl) statusEl.textContent = L.cw_autosaved;
    } catch (_) {}
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.data) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    var banner = $('wizardResumeBanner');
    if (banner) banner.hidden = true;
  }

  function setErr(msg) {
    var el = $('cwMsg');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'cp-msg' + (msg ? ' cp-msg--err' : '');
  }

  function renderStepsBar() {
    var bar = $('cwSteps');
    if (!bar) return;
    bar.textContent = '';
    [L.cw_step_1, L.cw_step_2, L.cw_step_3, L.cw_step_4, L.cw_step_5].forEach(function (label, idx) {
      var stepNum = idx + 1;
      var pill = document.createElement('span');
      pill.className = 'cw-step' + (state.step === stepNum ? ' cw-step--active' : (state.step > stepNum ? ' cw-step--done' : ''));
      if (state.step === stepNum) pill.setAttribute('aria-current', 'step');
      pill.textContent = label;
      bar.appendChild(pill);
    });
  }

  function renderChannels() {
    var box = $('cwChannelsBox');
    if (!box) return;
    box.textContent = '';
    CHANNELS.forEach(function (ch) {
      var btn = document.createElement('button');
      btn.type = 'button';
      var selected = state.channels.indexOf(ch) !== -1;
      btn.className = 'cw-chip' + (selected ? ' cw-chip--on' : '');
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      btn.textContent = ch.replace('_', ' ');
      btn.addEventListener('click', function () {
        var i = state.channels.indexOf(ch);
        if (i === -1) state.channels.push(ch);
        else state.channels.splice(i, 1);
        syncLinksWithChannels();
        saveDraft();
        renderChannels();
      });
      box.appendChild(btn);
    });
  }

  function syncLinksWithChannels() {
    if (!state.links.length && state.channels.length) {
      state.links = state.channels.map(function (ch) {
        return { channel: ch, url: '', generate_qr: ch === 'print_qr' };
      });
    }
  }

  function renderLinkRows() {
    var box = $('cwLinksBox');
    if (!box) return;
    box.textContent = '';
    state.links.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'cw-link-row';

      var chSelect = document.createElement('select');
      chSelect.className = 'cp-input';
      (state.channels.length ? state.channels : CHANNELS).forEach(function (ch) {
        var opt = document.createElement('option');
        opt.value = ch;
        opt.textContent = ch;
        if (ch === item.channel) opt.selected = true;
        chSelect.appendChild(opt);
      });
      chSelect.addEventListener('change', function () {
        state.links[idx].channel = chSelect.value;
        saveDraft();
      });

      var urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'cp-input';
      urlInput.placeholder = 'https://example.com/offer';
      urlInput.value = item.url || '';
      urlInput.addEventListener('input', function () {
        state.links[idx].url = urlInput.value.trim();
        saveDraft();
      });

      var qrWrap = document.createElement('label');
      qrWrap.className = 'cw-qr-toggle';
      var qrCheck = document.createElement('input');
      qrCheck.type = 'checkbox';
      qrCheck.checked = Boolean(item.generate_qr);
      qrCheck.addEventListener('change', function () {
        state.links[idx].generate_qr = qrCheck.checked;
        saveDraft();
      });
      var qrText = document.createElement('span');
      qrText.textContent = L.cw_qr_label;
      qrWrap.appendChild(qrCheck);
      qrWrap.appendChild(qrText);

      row.appendChild(chSelect);
      row.appendChild(urlInput);
      row.appendChild(qrWrap);
      box.appendChild(row);
    });
  }

  function renderPreview() {
    var box = $('cwPreviewBox');
    if (!box) return;
    box.textContent = '';
    var p = state.preview;
    if (!p) return;
    var summary = document.createElement('p');
    summary.className = 'cp-sub';
    summary.textContent = (p.campaign_preview.name || '') + ' (' + p.campaign_preview.status + ') — ' + (p.links_preview || []).length + ' link';
    box.appendChild(summary);
    (p.links_preview || []).forEach(function (l) {
      var item = document.createElement('div');
      item.className = 'cp-item';
      var left = document.createElement('span');
      left.textContent = '[' + l.channel + '] ' + (l.tagged_url || l.url);
      var right = document.createElement('span');
      right.textContent = l.valid ? (l.generate_qr ? 'OK + QR' : 'OK') : (l.error_code || 'INVALID');
      item.appendChild(left);
      item.appendChild(right);
      box.appendChild(item);
    });
  }

  function renderResult() {
    var box = $('cwResultBox');
    if (!box || !state.result) return;
    box.textContent = '';
    var r = state.result;
    var msg = document.createElement('p');
    msg.className = 'cp-msg ' + (r.launch_status === 'completed' ? 'cp-msg--ok' : 'cp-msg--err');
    msg.textContent = r.launch_status === 'completed' ? L.cw_ok_completed : L.cw_ok_partial;
    box.appendChild(msg);

    (r.assets || []).forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'cp-item';
      var left = document.createElement('span');
      left.textContent = '[' + a.channel + '] /' + a.link.short + (a.qr ? (' • QR: ' + a.qr.scan_path) : '');
      var right = document.createElement('span');
      right.textContent = a.status;
      row.appendChild(left);
      row.appendChild(right);
      box.appendChild(row);
    });

    (r.failures || []).forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'cp-item cp-msg--err';
      row.textContent = '[' + f.channel + '] ' + (f.error || f.error_code);
      box.appendChild(row);
    });
  }

  function renderStep() {
    setErr('');
    renderStepsBar();
    var hints = [L.cw_hint_1, L.cw_hint_2, L.cw_hint_3, L.cw_hint_4, L.cw_hint_5];
    var hintEl = $('cwHint');
    if (hintEl) hintEl.textContent = hints[state.step - 1] || '';

    for (var s = 1; s <= 5; s += 1) {
      var panel = $('cwPanel' + s);
      if (panel) panel.hidden = state.step !== s;
    }

    var prevBtn = $('cwPrevBtn');
    var nextBtn = $('cwNextBtn');
    if (prevBtn) prevBtn.hidden = state.step <= 1 || state.step === 5;
    if (nextBtn) {
      if (state.step === 4) nextBtn.textContent = L.cw_launch;
      else if (state.step === 5) nextBtn.textContent = L.cw_done_refresh;
      else nextBtn.textContent = L.cw_next;
    }

    if (state.step === 1) {
      if ($('cwName')) $('cwName').value = state.name;
      if ($('cwGoal')) $('cwGoal').value = state.goal;
      if ($('cwStatus')) $('cwStatus').value = state.status;
      if ($('cwBudget')) $('cwBudget').value = state.budget_amount;
      if ($('cwCurrency')) $('cwCurrency').value = state.budget_currency;
    } else if (state.step === 2) {
      renderChannels();
    } else if (state.step === 3) {
      syncLinksWithChannels();
      renderLinkRows();
    } else if (state.step === 4) {
      renderPreview();
    } else if (state.step === 5) {
      renderResult();
    }
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok && res.status !== 207) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function buildPayload() {
    return {
      name: state.name,
      goal: state.goal,
      status: state.status,
      budget_amount: state.budget_amount === '' ? null : Number(state.budget_amount),
      budget_currency: state.budget_amount === '' ? null : state.budget_currency,
      channels: state.channels,
      links: state.links.filter(function (l) { return l.url; }),
    };
  }

  function init() {
    var openBtn = $('openWizardBtn');
    var closeBtn = $('closeWizardBtn');
    var section = $('wizardSection');
    if (!openBtn || !section) return;

    openBtn.textContent = L.cw_open_btn;
    if (closeBtn) closeBtn.textContent = L.cw_close_btn;
    if ($('cwTitle')) $('cwTitle').textContent = L.cw_title;
    if ($('cwSub')) $('cwSub').textContent = L.cw_sub;
    if ($('cwAddLinkBtn')) $('cwAddLinkBtn').textContent = L.cw_add_link;
    if ($('cwResumeText')) $('cwResumeText').textContent = L.cw_resume_text;
    if ($('cwResumeBtn')) $('cwResumeBtn').textContent = L.cw_resume_btn;
    if ($('cwDiscardBtn')) $('cwDiscardBtn').textContent = L.cw_discard_btn;
    if ($('cwPrevBtn')) $('cwPrevBtn').textContent = L.cw_prev;

    var existing = loadDraft();
    if (existing && $('wizardResumeBanner')) {
      $('wizardResumeBanner').hidden = false;
    }

    openBtn.addEventListener('click', function () {
      section.hidden = !section.hidden;
      if (!section.hidden) renderStep();
    });
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { section.hidden = true; });
    }
    if ($('cwResumeBtn')) {
      $('cwResumeBtn').addEventListener('click', function () {
        var draft = loadDraft();
        if (draft && draft.data) {
          Object.assign(state, draft.data);
          state.step = Math.min(4, Math.max(1, Number(draft.step) || 1));
        }
        if ($('wizardResumeBanner')) $('wizardResumeBanner').hidden = true;
        section.hidden = false;
        renderStep();
      });
    }
    if ($('cwDiscardBtn')) {
      $('cwDiscardBtn').addEventListener('click', clearDraft);
    }

    ['cwName', 'cwGoal', 'cwStatus', 'cwBudget', 'cwCurrency'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () {
        state.name = ($('cwName') && $('cwName').value || '').trim();
        state.goal = ($('cwGoal') && $('cwGoal').value || '').trim();
        state.status = ($('cwStatus') && $('cwStatus').value) || 'active';
        state.budget_amount = ($('cwBudget') && $('cwBudget').value) || '';
        state.budget_currency = ($('cwCurrency') && $('cwCurrency').value) || 'AZN';
        saveDraft();
      });
    });

    if ($('cwAddLinkBtn')) {
      $('cwAddLinkBtn').addEventListener('click', function () {
        state.links.push({ channel: state.channels[0] || 'web', url: '', generate_qr: false });
        saveDraft();
        renderLinkRows();
      });
    }

    if ($('cwPrevBtn')) {
      $('cwPrevBtn').addEventListener('click', function () {
        if (state.step > 1) {
          state.step -= 1;
          saveDraft();
          renderStep();
        }
      });
    }

    if ($('cwNextBtn')) {
      $('cwNextBtn').addEventListener('click', function () {
        setErr('');
        if (state.step === 1) {
          state.name = ($('cwName') && $('cwName').value || '').trim();
          state.goal = ($('cwGoal') && $('cwGoal').value || '').trim();
          if (state.name.length < 2) { setErr(L.cw_err_name); return; }
          state.step = 2;
          saveDraft();
          renderStep();
          return;
        }
        if (state.step === 2) {
          if (!state.channels.length) { setErr(L.cw_err_channels); return; }
          state.step = 3;
          saveDraft();
          renderStep();
          return;
        }
        if (state.step === 3) {
          var nonEmpty = state.links.filter(function (l) { return l.url; });
          if (!nonEmpty.length) { setErr(L.cw_err_links); return; }
          postJson('/api/campaigns/wizard-preview', buildPayload())
            .then(function (data) {
              state.preview = data;
              state.step = 4;
              saveDraft();
              renderStep();
            })
            .catch(function (err) { setErr(err.message); });
          return;
        }
        if (state.step === 4) {
          var btn = $('cwNextBtn');
          btn.disabled = true;
          btn.textContent = L.cw_launching;
          postJson('/api/campaigns/launch', buildPayload())
            .then(function (data) {
              state.result = data;
              state.step = 5;
              if (data.launch_status === 'completed') clearDraft();
              renderStep();
            })
            .catch(function (err) { setErr(err.message); })
            .finally(function () { btn.disabled = false; });
          return;
        }
        if (state.step === 5) {
          section.hidden = true;
          if ($('campaignRefresh')) $('campaignRefresh').click();
        }
      });
    }
  }

  init();
})();
