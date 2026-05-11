# AiFlow

**AiFlow** is a convenient desktop application designed to consolidate all your favorite neural networks and web services in one place. 

Initially conceived as an AI tool aggregator, it functions as a universal hub: you can add absolutely any links, manage them, and keep the services you need close at hand.

## Core Features

- **AI Aggregator:** Quick access to your favorite AI services from a single window.
- **Universal Links:** Add any web resources, not limited to just neural networks.
- **Pinned Tabs:** Pin your most important links for instant access.
- **Local Database:** Your saved links and settings are stored locally on your device.
- **Google Synchronization:** Supports login via Google services (see instructions below).

---

## How Google Authorization Works (Important!)

Due to Google's strict security mechanisms, the login process for the application has some specific nuances. Please follow these instructions:

1. Click the **Login** button in the bottom left panel of the application.
2. Authorize in the window that opens in your default web browser.
3. Return to the AiFlow app and **log in once more** (inside the application interface).

### Troubleshooting Login Issues:
* **Nothing happens or an error occurs:** Wait about 10 seconds and try clicking the login button again. This delay is related to Google's security check specifics.
* **Global Account:** Successful login is only possible using the Google account you are globally logged into on your system/browser.
* **Incorrect Email / Repeated Errors:** Ensure you have selected the correct email. If the error persists, take a pause and make a couple more attempts — Google's system sometimes requires time to verify a new login.

---

## Development

If you want to run the project from source or build it yourself:

### Install and Run

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app in development mode:
   ```bash
   npm run dev
   ```

### Build for Windows (`.exe`)

1. Create installer:
   ```bash
   npm run dist
   ```
2. The output file will appear in the `dist/` folder.

**Important Technical Notes:**
- On the first launch, the app automatically creates a runtime configuration file at `userData/.env`.
- For Google OAuth to work correctly, you must set the `GOOGLE_OAUTH_CLIENT_ID` variable in the local `.env` file **before** packaging. Alternatively, you can update the runtime `.env` file after installing the application.