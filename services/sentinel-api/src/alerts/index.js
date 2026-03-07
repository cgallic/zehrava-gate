const db = require('../db');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function send(incidentId, failure) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('No Discord webhook configured, skipping alert');
    return { skipped: true };
  }

  const incident = db.getIncident(incidentId);
  if (!incident) {
    throw new Error(`Incident ${incidentId} not found`);
  }

  // Check if already alerted (avoid spam)
  if (incident.alert_sent) {
    console.log(`Alert already sent for incident ${incidentId}`);
    return { skipped: true, reason: 'already_sent' };
  }

  // Build Discord embed
  const embed = {
    title: `🚨 Agent Failure: ${failure.type}`,
    description: `Agent **${incident.agent_id}** experienced a ${failure.severity} failure`,
    color: getSeverityColor(failure.severity),
    fields: [
      {
        name: 'Type',
        value: failure.type,
        inline: true
      },
      {
        name: 'Severity',
        value: failure.severity,
        inline: true
      },
      {
        name: 'Run ID',
        value: incident.run_id || 'N/A',
        inline: true
      },
      {
        name: 'Details',
        value: formatDetails(failure.details)
      }
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: `Incident ID: ${incidentId}`
    }
  };

  // Add replay context if available
  if (incident.context?.recent_events?.length > 0) {
    const recentSteps = incident.context.recent_events
      .slice(0, 5)
      .map(e => `• ${e.type}: ${e.payload?.step || e.payload?.action || '...'}`)
      .join('\n');
    
    embed.fields.push({
      name: 'Recent Events (Last 5)',
      value: recentSteps || 'No recent events'
    });
  }

  const payload = {
    embeds: [embed],
    content: failure.severity === 'P0' ? '@here Critical agent failure!' : undefined
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Log alert
    db.createAlert({
      id: require('uuid').v4(),
      incident_id: incidentId,
      channel: 'discord',
      payload,
      response_status: response.status,
      sent_at: Date.now()
    });

    // Mark incident as alerted
    if (response.ok) {
      db.markAlertSent(incidentId);
    }

    return {
      sent: response.ok,
      status: response.status,
      incident_id: incidentId
    };
  } catch (err) {
    console.error('Discord alert failed:', err);
    throw err;
  }
}

function getSeverityColor(severity) {
  switch (severity) {
    case 'P0': return 0xff0000; // Red
    case 'P1': return 0xff8800; // Orange
    case 'P2': return 0xffcc00; // Yellow
    default: return 0x808080;   // Gray
  }
}

function formatDetails(details) {
  if (!details) return 'No details available';
  
  return Object.entries(details)
    .map(([key, value]) => {
      if (typeof value === 'object') {
        return `**${key}:** \`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
      }
      return `**${key}:** ${value}`;
    })
    .join('\n');
}

module.exports = {
  send
};
