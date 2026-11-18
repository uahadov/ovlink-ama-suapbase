/* Ovlink campaign CSV export. No dependencies; usable in the browser and Node tests. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OvlinkCampaignReport = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function cell(value) {
    var raw = value == null ? '' : String(value);
    // Spreadsheet formula injection: never let server/user supplied text
    // become a spreadsheet formula, including leading whitespace variants.
    if (/^[\s\uFEFF\u200B]*[=+@-]/.test(raw)) raw = "'" + raw;
    return '"' + raw.replace(/"/g, '""') + '"';
  }
  function numeric(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  function toCsv(data) {
    if (!data || !data.campaign || !data.range) throw new TypeError('Campaign report data is missing');
    var lines = [];
    function add() { lines.push(Array.from(arguments).map(cell).join(',')); }
    function blank() { lines.push(''); }

    add('Ovlink campaign report', 'v1');
    add('Campaign', data.campaign.name);
    add('Campaign slug', data.campaign.slug);
    add('Date from (UTC)', data.range.from);
    add('Date to (UTC)', data.range.to);
    add('Bot filter (source breakdown only)', data.range.bots === 'include' ? 'Included' : 'Excluded');
    add('Totals methodology', 'Click, unique and conversion totals use daily aggregates and may include bots');
    add('Generated at (UTC)', data.generated_at);
    blank();
    add('Metric', 'Value');
    add('Links', numeric(data.links_count));
    add('Clicks', numeric(data.clicks));
    add('Unique visitors', numeric(data.uniques));
    add('Conversions', numeric(data.conversions));
    add('Conversion rate (%)', numeric(data.conversion_rate));
    blank();
    add('Daily clicks');
    add('Date', 'Clicks');
    (Array.isArray(data.clicks_by_day) ? data.clicks_by_day : []).forEach(function (point) {
      add(point.date, numeric(point.count));
    });
    blank();
    add('Top links');
    add('Short code', 'Destination', 'Clicks', 'Unique visitors', 'Conversions');
    (Array.isArray(data.top_links) ? data.top_links : []).forEach(function (link) {
      add(link.short, link.original, numeric(link.clicks), numeric(link.uniques), numeric(link.conversions));
    });
    blank();
    add('Sources');
    add('Source', 'Clicks');
    (Array.isArray(data.top_sources) ? data.top_sources : []).forEach(function (source) {
      add(source.name, numeric(source.count));
    });
    blank();
    add('Conversion goals');
    add('Goal', 'Conversions');
    (Array.isArray(data.top_goals) ? data.top_goals : []).forEach(function (goal) {
      add(goal.name, numeric(goal.count));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  function filename(data) {
    var slug = String(data && data.campaign && data.campaign.slug || 'campaign').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70);
    return 'ovlink-campaign-' + (slug || 'campaign') + '-report.csv';
  }
  return { toCsv: toCsv, filename: filename };
});
