# Executive Summary

This guide details a **copy-paste ready Node.js/Express** MVP for an AI-driven clinic receptionist. We cover Twilio voice webhooks, OpenAI Whisper/GPT, ElevenLabs TTS, and PostgreSQL integration.

Flow:

**Call arrives → Record audio → Whisper STT → GPT booking assistant → store appointment → ElevenLabs TTS reply → SMS confirmation**.

We use TwiML `<Record>` (with callback) to capture speech, then respond with a voice confirmation.

```mermaid
flowchart TD
    Caller(Caller) -->|Calls clinic| Twilio[Twilio Voice Service]
    Twilio -->|Webhook POST| AppServer["/voice\n(Node/Express)"]
    AppServer -->|Return TwiML| CallerInstr["Caller hears instructions"]
    CallerInstr -->|User speaks & presses *| Twilio
    Twilio -->|Redirect after Record| RecordHandler["/handle-record\n(Node/Express)"]
    RecordHandler -->|Fetch audio| Whisper[OpenAI Whisper (STT)]
    Whisper -->|text| GPT["OpenAI GPT (LLM)"]
    GPT -->|store| PostgreSQL[(PostgreSQL)]
    GPT -->|text| Eleven[TTS (ElevenLabs)]
    Eleven -->|MP3| AudioFile["/public/audio/tts.mp3"]
    RecordHandler -->|Return TwiML <Play>| CallerAudio["Caller hears confirmation"]
    GPT -->|SMS API| TwilioSMS["Twilio Programmable SMS"]
    TwilioSMS -->|Sends SMS| Caller
```

## Folder Structure

```plaintext
clinic-ai-receptionist/
├── src/
│   ├── index.js           # Main Express app with routes
│   ├── audioHandler.js    # (optional) helper for audio download & processing
│   ├── voiceService.js    # (optional) Twilio SDK calls (SMS, etc.)
├── public/
│   └── audio/
│       └── tts.mp3        # Generated TTS file to play
├── migrations/
│   └── create_appointments_table.sql
├── .env                   # Environment variables
├── package.json
└── README.md
```

## Dependencies

```bash
npm install express twilio openai axios pg dotenv
```

## 1) Twilio Webhook – `/voice` Route

```js
// src/index.js (excerpt)
import express from 'express';
import { urlencoded } from 'body-parser';
import twilio from 'twilio';

const { VoiceResponse } = twilio.twiml;
const app = express();
app.use(urlencoded({ extended: false }));

app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'alice', language: 'en-US' },
    'Hello! Please say your name and appointment details after the beep, then press the star key when finished.'
  );
  twiml.record({
    action: '/handle-record',
    method: 'POST',
    maxLength: 30,
    finishOnKey: '*',
    trim: 'trim-silence'
  });

  res.type('text/xml');
  res.send(twiml.toString());
});
```

## 2) Recording Callback – `/handle-record` Route

```js
import fs from 'fs';
import axios from 'axios';
import { Client } from 'pg';
import OpenAI from 'openai';
import twilio from 'twilio';

const { VoiceResponse } = twilio.twiml;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.post('/handle-record', async (req, res) => {
  try {
    const recordingUrl = `${req.body.RecordingUrl}.wav`;
    const callerNumber = req.body.From;

    // 1. Download audio from Twilio
    const audioRes = await axios.get(recordingUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync('temp.wav', audioRes.data);

    // 2. Transcribe via OpenAI
    const transcriptionRes = await openai.audio.transcriptions.create({
      model: 'gpt-4o-transcribe',
      file: fs.createReadStream('temp.wav')
    });
    const userText = transcriptionRes.text;

    // 3. Create confirmation via LLM
    const gptRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a medical receptionist AI. When the user describes an appointment request, reply with a confirmation message only. Do not ask questions.'
        },
        { role: 'user', content: userText }
      ]
    });
    const confirmationText = gptRes.choices[0].message.content.trim();

    // 4. Store booking in PostgreSQL
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('INSERT INTO appointments (phone, notes) VALUES ($1, $2)', [callerNumber, userText]);
    await client.end();

    // 5. Generate TTS with ElevenLabs
    const ttsRes = await axios.post(
      'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM',
      { text: confirmationText, model_id: 'eleven_multilingual_v2' },
      {
        headers: {
          'xi-api-key': process.env.ELEVEN_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );
    fs.writeFileSync('public/audio/tts.mp3', ttsRes.data);

    // 6. Respond with TwiML <Play>
    const response = new VoiceResponse();
    response.play(`${process.env.HOST_URL}/audio/tts.mp3`);
    response.hangup();
    res.type('text/xml').send(response.toString());

    // 7. Send SMS confirmation
    await twilioClient.messages.create({
      to: callerNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: `Confirmed: ${confirmationText}`
    });
  } catch (err) {
    console.error('Error handling recording:', err);
    const resp = new VoiceResponse();
    resp.say('Sorry, an error occurred. Please try again later.');
    res.type('text/xml').send(resp.toString());
  }
});
```

## 3) Database Schema

```sql
CREATE TABLE appointments (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(32),
  name VARCHAR(100),
  timeslot TIMESTAMP,
  notes TEXT
);
```

## 4) Environment Variables

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `OPENAI_API_KEY`
- `ELEVEN_API_KEY`
- `DATABASE_URL`
- `HOST_URL`

## 5) Quick Test Flow

1. Run the server: `node src/index.js`
2. Expose with ngrok: `ngrok http 3000`
3. Configure Twilio Voice webhook to `https://<ngrok>/voice` (POST)
4. Call number, speak details, press `*`
5. Confirm TTS playback, SMS delivery, and DB insert

## Security & Privacy Notes

- Use HTTPS everywhere.
- Validate Twilio webhook signatures.
- Avoid storing raw audio longer than necessary.
- Do not log PHI.
- Use least-privilege credentials and secret management.

## References

- Twilio Voice `<Record>` and callback behavior.
- OpenAI Audio transcription API.
- OpenAI chat completion API.
- ElevenLabs text-to-speech API.
