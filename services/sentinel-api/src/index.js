require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const detectors = require('./detectors');
const alerts = require('./alerts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0', timestamp: Date.now() });
});

// Event ingestion
app.post('/v1/events', (req, res) => {
  try {
    const event = {
      id: uuidv4(),
      agent_id: req.body.agent_id,
      run_id: req.body.run_id,
      type: req.body.type,
      payload: req.body.payload || {},
      timestamp: req.body.timestamp || Date.now()
    };

    // Validate required fields
    if (!event.agent_id || !event.run_id || !event.type) {
      return res.status(400).json({ 
        error: 'Missing required fields: agent_id, run_id, type' 
      });
    }

    // Store event
    db.createEvent(event);

    // Run detectors
    const detectedFailures = detectors.check(event);
    
    // Create incidents for detected failures
    for (const failure of detectedFailures) {
      const incidentId = uuidv4();
      db.createIncident({
        id: incidentId,
        agent_id: event.agent_id,
        run_id: event.run_id,
        type: failure.type,
        severity: failure.severity,
        first_event_id: event.id,
        started_at: Date.now(),
        context: {
          failure_details: failure.details,
          recent_events: db.getEventsForRun(event.run_id, 5)
        }
      });

      // Send alert (async, don't block)
      alerts.send(incidentId, failure).catch(err => {
        console.error('Alert failed:', err.message);
      });
    }

    res.json({ event_id: event.id, incidents_created: detectedFailures.length });
  } catch (err) {
    console.error('Event ingestion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get incidents
app.get('/v1/incidents', (req, res) => {
  try {
    const incidents = db.getIncidents({
      agent_id: req.query.agent_id,
      status: req.query.status,
      severity: req.query.severity,
      limit: parseInt(req.query.limit) || 50
    });
    res.json({ incidents });
  } catch (err) {
    console.error('Get incidents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single incident
app.get('/v1/incidents/:id', (req, res) => {
  try {
    const incident = db.getIncident(req.params.id);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    
    // Include recent events for replay context
    const events = db.getEventsForRun(incident.run_id, 10);
    
    res.json({ incident, events });
  } catch (err) {
    console.error('Get incident error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Acknowledge incident
app.post('/v1/incidents/:id/acknowledge', (req, res) => {
  try {
    const incident = db.getIncident(req.params.id);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    
    db.updateIncidentStatus(req.params.id, 'acknowledged');
    res.json({ incident_id: req.params.id, status: 'acknowledged' });
  } catch (err) {
    console.error('Acknowledge error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resolve incident
app.post('/v1/incidents/:id/resolve', (req, res) => {
  try {
    const incident = db.getIncident(req.params.id);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    
    db.updateIncidentStatus(req.params.id, 'resolved');
    res.json({ incident_id: req.params.id, status: 'resolved' });
  } catch (err) {
    console.error('Resolve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get events for a run (replay)
app.get('/v1/runs/:runId/events', (req, res) => {
  try {
    const events = db.getEventsForRun(req.params.runId, 100);
    res.json({ run_id: req.params.runId, events });
  } catch (err) {
    console.error('Get run events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register agent
app.post('/v1/agents', (req, res) => {
  try {
    const agent = {
      id: req.body.id || uuidv4(),
      name: req.body.name,
      config: req.body.config || {}
    };
    
    if (!agent.name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }
    
    db.registerAgent(agent);
    res.json({ agent_id: agent.id, name: agent.name });
  } catch (err) {
    console.error('Register agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Agent Sentinel API listening on port ${PORT}`);
  console.log(`Database: ${process.env.DATABASE_PATH || './sentinel.db'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.closeDb();
  process.exit(0);
});
