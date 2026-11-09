# Historia zmian

## 0.3.0 (2026-11-09)

- Bez ingerencji w wygląd LinkedIna: zniknął przycisk ✦ Asystent ze strony. Otwarty panel sam pobiera post, w którego polu komentarza klikniesz. „…więcej” wtyczka rozwija tylko na Twoje kliknięcie w panelu. Gdy masz pracę w toku, panel nie przełącza się sam, tylko proponuje przełączenie.
- Twój styl: wtyczka zapamiętuje komentarze, które wstawiasz lub kopiujesz (lokalnie, do 100). Ostatnie trafiają do promptu jako wzór. Z Twoich ręcznych poprawek uczy się listy preferencji, którą możesz edytować w ustawieniach.
- Kontrola jakości przed wstawieniem: natychmiastowe wykrywanie ogólników i wzorców AI oraz ocena modelu (czy komentarz tylko powtarza post, czy pasuje pod każdy post, czy dopisuje fakty). Przycisk „Konkretniej” poprawia komentarz według znalezionych problemów.
- Bogatszy kontekst: opis autora, podlinkowany artykuł i do 3 komentarzy innych osób (model nie powtarza ich myśli).
- Opcjonalnie Harmonic: etap, finansowanie, zespół i inwestorzy firmy autora oraz jego rola. Do modelu trafiają tylko publiczne fakty. Nowe uprawnienie: `https://api.harmonic.ai/*`.
- Poprawki: ukryte elementy panelu (np. „Uwzględnij grafikę” przy poście bez grafiki) naprawdę się ukrywają. Polskie frazy z ogonkami są wykrywane w kontroli jakości.

## 0.2.0 (2026-11-09)

- Reguły stylu w prompcie: angielskie na podstawie `humanizer` (komentarze po angielsku) i polskie na podstawie `miodkuj` (komentarze po polsku, tłumaczenia, pomysły, uwagi). Tłumaczenie zwrotne zostaje dosłowne.
- Domyślne „O mnie” z prywatnego pliku `local-config/defaults.json` (poza Gitem): wpisywane raz, tylko w puste pole, bez kluczy API.
- Cache promptu systemowego przy API Anthropic: kolejne zapytania w ciągu 5 minut są tańsze. Szacunek kosztu uwzględnia ceny odczytu z cache.
- Panel: wyraźniejsza hierarchia nagłówków, cytat posta bez bocznej kreski.
- Numer wersji: jedno źródło (`package.json`), `npm version` aktualizuje też manifest, a build zatrzymuje się przy niezgodności.

## 0.1.0 (2026-11-09)

- Pierwsza wersja: panel boczny przypięty do posta, przycisk ✦ Asystent przy polu komentarza, tłumaczenie posta i pomysły, komentarz z tłumaczeniem zwrotnym i uwagami, poprawki, wstawianie pod właściwy post.
- Dostawcy: API Anthropic albo OpenRouter, modele Sonnet 5.5 / Opus 5.5.
