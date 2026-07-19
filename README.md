# Kalorie 🍏

Jednoduchá a přesná aplikace na počítání kalorií v češtině. Běží v prohlížeči, jde
nainstalovat na iPhone jako běžná appka a funguje i bez internetu. Data zůstávají
jen v telefonu — nikam se neposílají.

## Funkce
- **Deník jídel** po jednotlivých jídlech (snídaně / oběd / večeře / svačiny)
- **Denní kruh** s kalorickým cílem a makry (bílkoviny / sacharidy / tuky)
- **Databáze ~240 českých potravin** i hotových jídel (na 100 g, s reálnými porcemi)
- **Vyhledávání na internetu** v Open Food Facts (produkty z českých obchodů)
- **Skener čárových kódů** (kamera telefonu)
- **Rychlý zápis** kalorií (např. jídlo v restauraci)
- **Vlastní potraviny** z obalu — zadáte jednou, používáte pořád
- **Váha** s grafem vývoje a **pitný režim**
- **Kalkulačka doporučeného příjmu** (Mifflin–St Jeor)
- **Záloha / obnova** dat do souboru

## Instalace na iPhone
1. Otevřete adresu aplikace v **Safari**.
2. Klepněte na **Sdílet** (ikona čtverečku se šipkou).
3. Zvolte **Přidat na plochu** → **Přidat**.
4. Appka „Kalorie" se objeví na ploše a otevírá se na celou obrazovku.

## Provoz lokálně (pro vývoj)
```
python -m http.server 8777 -d .
```
Pak otevřít `http://localhost:8777`.

## Nasazení
Statická stránka — funguje na GitHub Pages, Vercelu i Netlify. Stačí naservírovat
obsah složky přes HTTPS (kvůli instalaci a offline režimu).

## Technologie
Čisté HTML/CSS/JS, žádný framework, žádný backend. PWA se service workerem
(offline) a `localStorage` pro data. Ikony generuje `make_icons.py` (Pillow).

## Zdroje dat
Hodnoty potravin dle běžných nutričních tabulek; produkty z
[Open Food Facts](https://openfoodfacts.org) (licence ODbL). Kalorie jsou orientační.
