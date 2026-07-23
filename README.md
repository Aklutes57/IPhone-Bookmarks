# Bookmark Launcher

### Open the app here: **https://aklutes57.github.io/IPhone-Bookmarks/**

Tap that link on your phone, add it to your Home Screen once, and the app lives right on your Home Screen.

## 1. What this is

Bookmark Launcher gives you a grid of tappable icons, just like the app screen on your phone. Each tile is one of your saved sites. Tap a tile and it opens that site in Chrome, where you're signed in as always. Everything stays on your phone. Nothing is uploaded anywhere.

## 2. Get your bookmarks out of Chrome (do this on a computer)

Chrome on your phone can't export bookmarks, but it syncs them to Chrome on your computer, so that's where you do this part.

1. On your computer, open Chrome and go to `chrome://bookmarks`.
2. Click the three-dot menu on the bookmarks page (top right of that page, not the main Chrome menu).
3. Choose **Export bookmarks**.
4. Save the file with a name you'll remember, like `personal-bookmarks.html` or `work-bookmarks.html`.

If you use more than one Google account or Chrome profile, repeat these steps for each one so you get a separate file for each.

This also works with bookmark files exported from Safari, Firefox, or Edge — the steps are the same, just use that browser's Export Bookmarks option.

## 3. Get the files onto your phone

Now move the file (or files) you just saved onto your phone. The easiest ways are:

- Email the file to yourself, then open the email on your phone.
- Or put the file in Google Drive on your computer and open Drive on your phone.

Why this is safe: the app keeps everything on your phone and never uploads anything. You're just moving the file over to your phone, the same way you'd move a photo.

## 4. Import your bookmarks into the app

1. Open the app URL in Chrome on your phone: **https://aklutes57.github.io/IPhone-Bookmarks/**
2. Open the menu and choose **Import bookmarks**.
3. Pick the file you moved onto your phone.
4. Give this set a short name, like `Personal` or `Work`.
5. If you have more than one file, repeat for each one.

Later on, if you want to refresh a set, just re-export from Chrome and import again using the **same name**. That replaces the old set with the fresh one.

## 5. Put it on your Home Screen

This is what makes it feel like a real app.

- **Android (Chrome):** Open the menu (⋮) and tap **Add to Home screen**. It may say **Install app** instead. Either one works.
- **iPhone / iPad:** You must use **Safari** for this step. Open the app URL in Safari, tap the **Share** button, then tap **Add to Home Screen**.

## 6. About your passwords

The app never sees, stores, or asks for your passwords. When you tap a tile, it opens the real website in Chrome, and Chrome's own password manager fills in your login exactly like it always does.

Phones don't let apps read Chrome's saved passwords, and that's a good thing. If any app ever asks to handle your saved passwords, treat that as a red flag.

## 7. Tips and troubleshooting

- **Your data stays on this device.** If you clear the browser's data, you'll need to import your bookmarks again.
- **Add a single site by hand** any time from the menu, without importing a whole file.
- **Press and hold a tile** to rename or delete it.
- **A letter tile instead of a site's logo is normal.** Some sites just don't hand over an icon, so you get a colored letter instead.
- **On iPhone:** if your bookmarks ever seem to vanish, import the file again. It also helps to use the version you added to your Home Screen rather than a fresh Safari tab.
- **On Android, add a page straight from Chrome.** Open the page in Chrome, tap **Share**, then tap **Bookmarks** to send it right into the app. If you don't see Bookmarks in the share list yet, give it up to a day — Android can be slow to notice a newly added app there. Removing the app's Home Screen icon and adding it again usually gets it to show up sooner.
- **Updates are automatic.** When a new version is ready, you'll see a small "tap to reload" message. Tap it and you're up to date.

## How this app was made

This whole app was vibecoded — I described what I wanted in plain English and
Claude (an AI) designed, wrote, and tested all of the code. I don't have much
experience with code myself, so if you're reading this repo: the code is the
AI's work, reviewed and steered by me through conversation.

## For developers

This is a vanilla progressive web app. No frameworks, no build step, no dependencies.

For local development, serve the folder with any static server, for example:

```
python3 -m http.server
```

A plain server is required because the service worker won't run from `file://`.

Deployment is handled by GitHub Actions (`.github/workflows/deploy.yml`), which publishes to GitHub Pages at the canonical URL on every push to `main`:

**https://aklutes57.github.io/IPhone-Bookmarks/**
