export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function shell(title, body, { user, devAuth, provider } = {}) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · DynDNS</title><link rel="stylesheet" href="/style.css"></head><body><header><a class="brand" href="/">Dyn<span>DNS</span></a><span>Deine Verbindung. Deine Domain.</span></header>
  <main>${devAuth ? '<p class="notice">Lokale Entwicklung: Testkonto ohne ZugangsWerk.</p>' : ''}${provider === 'mock' ? '<p class="notice">Testbetrieb: Es werden keine öffentlichen DNS-Einträge verändert.</p>' : ''}${body}</main><footer>DynDNS${user ? ` · ${escapeHtml(user.name)}` : ''}</footer></body></html>`;
}

const csrfInput = csrf => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
export function loginPage(config, csrf) {
  return shell('Anmelden', `<section class="hero"><p class="eyebrow">DYNAMISCHES DNS</p><h1>Eine feste Adresse.<br>Auch wenn deine IP wechselt.</h1><p>Verwalte deine Hostnamen und verbinde Router oder Server mit deinem eigenen DynDNS-Dienst.</p>${config.devAuth ? `<form method="post" action="/auth/dev">${csrfInput(csrf)}<button>Lokales Testkonto öffnen</button></form>` : '<a class="button" href="/auth/login">Mit ZugangsWerk anmelden</a>'}</section>`, config);
}

export function dashboard(config, user, csrf, hosts, records, canWrite) {
  const rows = hosts.map(host => {
    const ips = records.filter(record => record.host_id === host.id);
    return `<tr><td><strong>${escapeHtml(host.hostname)}</strong><small>${ips.length ? ips.map(ip => `${escapeHtml(ip.type)}: ${escapeHtml(ip.address)}`).join('<br>') : 'Noch kein Update'}</small></td>
      <td><span class="badge ${host.enabled ? '' : 'off'}">${host.enabled ? 'Aktiv' : 'Pausiert'}</span><small>${host.last_update ? escapeHtml(host.last_update) + ' UTC' : '—'}</small></td>
      <td>${canWrite ? `<form method="post" action="/hosts/${host.id}/rotate">${csrfInput(csrf)}<button class="secondary">Neuer Token</button></form><form method="post" action="/hosts/${host.id}/toggle">${csrfInput(csrf)}<button class="secondary">${host.enabled ? 'Pausieren' : 'Aktivieren'}</button></form>` : 'Nur Lesezugriff'}</td></tr>`;
  }).join('');
  return shell('Hostnamen', `<div class="heading"><div><p class="eyebrow">DEIN NETZWERK</p><h1>Hostnamen</h1><p>Erreichbar bleiben, auch mit wechselnder IP.</p></div><form method="post" action="/auth/logout">${csrfInput(csrf)}<button class="secondary">Abmelden</button></form></div>
  <section class="card"><div class="section-heading"><h2>Deine Adressen</h2><span>${hosts.length} / ${config.maxHosts}</span></div>${hosts.length ? `<div class="table-scroll"><table><thead><tr><th>Hostname / IP</th><th>Status / Letztes Update</th><th>Aktionen</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">Noch keine Hostnamen. Lege deine erste Adresse an und hinterlege den Update-Token in deinem Router.</p>'}</section>
  ${canWrite ? `<section class="card"><h2>Hostname anlegen</h2><form method="post" action="/hosts" class="create">${csrfInput(csrf)}<label for="label">Name</label><div class="input-group"><input id="label" name="label" required pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" maxlength="63" placeholder="zuhause" autocomplete="off"><span>.${escapeHtml(config.dynDomain)}</span></div><button>Hostname anlegen</button></form></section>` : ''}
  <section class="card"><h2>Router verbinden</h2><p>Update-Adresse: <code>${escapeHtml(config.appUrl)}/nic/update</code></p><p>Benutzername ist der vollständige Hostname, Passwort ist sein Update-Token. Änderungen können bis zu ${config.ttl} Sekunden im DNS-Cache bleiben.</p><p>Ein neuer Token ersetzt den bisherigen sofort. Pausieren sperrt weitere Updates; vorhandene DNS-Einträge bleiben bestehen.</p></section>`, { ...config, user });
}

export function tokenPage(config, user, hostname, token) {
  return shell('Update-Token', `<section class="card"><p class="eyebrow">ZUGANG FÜR DEINEN ROUTER</p><h1>Update-Token erstellt</h1><p>Dieser Token wird nur jetzt angezeigt. Speichere ihn im Passwortmanager oder direkt in deinem Router.</p><dl><dt>Hostname / Benutzername</dt><dd><code>${escapeHtml(hostname)}</code></dd><dt>Passwort / Update-Token</dt><dd><code class="secret">${escapeHtml(token)}</code></dd><dt>Update-URL</dt><dd><code>${escapeHtml(config.appUrl)}/nic/update?hostname=${escapeHtml(hostname)}&amp;myip=&lt;ipaddr&gt;</code></dd></dl><p>Benutzername und Token per HTTP Basic Authentication über HTTPS senden. Den Token nicht in die URL schreiben.</p><a class="button" href="/">Zu den Hostnamen</a></section>`, { ...config, user });
}

export function errorPage(status, message) {
  return shell(`Fehler ${status}`, `<section class="card"><h1>${status}</h1><p>${escapeHtml(message)}</p><a href="/">Zur Übersicht</a>${status === 401 ? '<p><a href="/auth/login">Erneut anmelden</a></p>' : ''}</section>`);
}
