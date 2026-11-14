# Asystent komentarzy LinkedIn

Rozszerzenie do Microsoft Edge (działa też w Chrome), które pomaga pisać komentarze na LinkedInie z pomocą Claude. Piszesz po polsku, a wtyczka:

1. **tłumaczy post na polski**, a długi streszcza, i opisuje, co widać na grafice;
2. **podsuwa 3 pomysły na komentarz**, dopasowane do posta, do Ciebie i do tego, co inni już napisali;
3. **zamienia Twoje polecenie albo szkic na gotowy komentarz** w języku posta, zwykle po angielsku, w Twoim stylu, razem z tłumaczeniem zwrotnym i uwagami językowymi;
4. **sprawdza komentarz przed wstawieniem**: ostrzega, gdy tylko powtarza post albo brzmi ogólnikowo;
5. **wstawia komentarz w pole pod właściwym postem**, nawet jeśli feed się w międzyczasie przewinął.

To samo działa w **wiadomościach**: wtyczka tłumaczy ostatnie wiadomości rozmówcy, podsuwa pomysły na odpowiedź i wstawia ją do pola wiadomości, niczego nie wysyłając.

Do tego wtyczka tłumaczy zaznaczony tekst i komentarze innych osób pod postem, odzyskuje własne szkice i pozwala wracać do wcześniejszych wersji. Obsługuje ręcznie dodane obrazy, rozpoznane dokumenty i ankiety. Historię swoich tekstów oraz ustawienia możesz wyeksportować na inny komputer.

Komentarz zawsze publikujesz Ty, przyciskiem LinkedIna. Model to Claude Sonnet 5.5 albo Opus 5.5, przez API Anthropic albo przez OpenRouter.

Historia zmian: [`CHANGELOG.md`](CHANGELOG.md). Decyzje projektowe: [`docs/2026-11-09-design.md`](docs/2026-11-09-design.md), od wersji 0.5.0 także [`docs/2026-11-10-design-0.5.md`](docs/2026-11-10-design-0.5.md).

## Stan wersji 0.8.0

| Obszar | Działanie |
|---|---|
| Kontekst | Rozróżnia post, konkretną odpowiedź na komentarz i rozmowę. Przed wstawieniem ponownie sprawdza cel i treść źródła. |
| Ton, długość i „O mnie” | Wybór tonu i długości ma pierwszeństwo przed zapisanymi wskazówkami stylu. Nowy profil i preferencje działają od kolejnego pisania lub poprawki. |
| Szkice | Automatyczny zapis, do 8 wersji, odtworzenie po zamknięciu panelu. Trwały zapis do 7 dni wymaga osobnego włączenia. |
| Zadania i koszty | „Przerwij”, „Ponów” oraz szczegóły modelu, tokenów, cache i czasu zadania. |
| Media | Ankiety, dostępne obrazy stron dokumentu i własne zrzuty. Do 6 obrazów na zapytanie; panel pokazuje zakres odczytu. |

Pełny przebieg testów wersji 0.8.0 zakończył się wynikiem **107 testów jednostkowych i 40 E2E bez błędów**. Testy przeglądarkowe korzystają z atrap LinkedIna i API. Sprawdzają mechanikę oraz zawartość zapytań, ale nie potwierdzają jakości odpowiedzi rzeczywistego modelu. Odczyt dokumentów i ankiet nadal wymaga sprawdzenia na bieżącym LinkedInie.

Na skróty: [instalacja](#instalacja), [używanie](#jak-używać), [ton, długość i profil](#ton-długość-i-kontekst-o-tobie), [prywatność](#prywatność-i-bezpieczeństwo), [aktualizacja](#aktualizacja-i-wersje), [testy](#testy).

## Wymagania

- Microsoft Edge albo Chrome w wersji 116 lub nowszej.
- Node.js 20 lub nowszy (do budowania i testów).
- Klucz API Anthropic albo OpenRouter.
- Opcjonalnie: klucz API Harmonic (plan z dostępem do API).

## Instalacja

Kod jest w prywatnym repozytorium [auditlog/linkedin-comment-assistant](https://github.com/auditlog/linkedin-comment-assistant). Na tym komputerze leży w `C:\code\linkedin_plugin` (w WSL: `/mnt/c/code/linkedin_plugin`).

1. Pobierz kod (na nowym komputerze) i zbuduj rozszerzenie:
   ```bash
   git clone git@github.com:auditlog/linkedin-comment-assistant.git
   cd linkedin-comment-assistant
   npm ci
   npm run build
   ```
   Gotowa wtyczka trafia do folderu `dist/`.
2. W Edge otwórz `edge://extensions` i włącz **Tryb dewelopera** (przełącznik po lewej).
3. Kliknij **Załaduj rozpakowane** i wskaż folder `dist` w katalogu projektu, np. `C:\code\linkedin_plugin\dist`. Edge działa w Windows, więc projekt powinien leżeć na dysku Windows (w WSL: `/mnt/c/...`).
4. Przypnij ikonę do paska: ikona puzzla, a potem oko przy „Asystent komentarzy LinkedIn”.
5. Odśwież otwarte karty LinkedIna (F5).

## Pierwsze uruchomienie

Kliknij ikonę wtyczki. Panel boczny otworzy się na ustawieniach.

1. Wybierz dostawcę i wklej klucz API:

   | Dostawca | Skąd wziąć klucz | Postać klucza | Model domyślny |
   |---|---|---|---|
   | Anthropic | https://console.anthropic.com/settings/keys | `sk-ant-…` | `claude-sonnet-5-5` |
   | OpenRouter | https://openrouter.ai/keys | `sk-or-…` | `anthropic/claude-sonnet-5.5` |

2. Uzupełnij **O mnie**: swoją rolę, obszar pracy i fakty, do których model może nawiązywać. Preferencje pisania możesz wpisać w sekcji **Twój styl**, osobno dla komentarzy i wiadomości.
3. Kliknij **Sprawdź połączenie**, a potem **Zapisz ustawienia**.

## Jak używać

1. Otwórz panel ikoną wtyczki albo skrótem **Alt+Shift+L** i zostaw go otwartego.
2. Na LinkedInie kliknij w pole komentarza pod postem, bez względu na to, czy ma podpis „Dodaj komentarz…”, czy np. „Złóż życzenia…”. Panel sam pobierze ten post, a po chwili pokaże jego tłumaczenie i pomysły. Gdy post jest skrócony („…więcej”), kliknij w panelu **Rozwiń pełny tekst**.
3. Kliknij pomysł albo wpisz polecenie po polsku, np. „pogratuluj wejścia do Holandii i zapytaj, czy obsługują też floty mieszane”. Możesz też wpisać szkic po polsku albo po angielsku do poprawy. Wybierz ton i długość tekstu.
4. Kliknij **Napisz komentarz** (Ctrl+Enter). Przeczytaj tłumaczenie zwrotne i uwagi.
5. Jeśli coś nie pasuje, wpisz w polu **Popraw** np. „krócej” albo „bez pytania”. Tekst możesz też zmienić ręcznie. Model weźmie Twoje zmiany pod uwagę przy kolejnej poprawce.
6. Przeczytaj wynik kontroli jakości nad przyciskami. Jeśli komentarz tylko powtarza post albo brzmi ogólnikowo, kliknij **Konkretniej**.
7. Kliknij **Wstaw pod postem**, przeczytaj komentarz na LinkedInie i opublikuj go.

Przy odpowiedzi na komentarz kliknij w pole odpowiedzi. Asystent weźmie pod uwagę post i komentarz, na który odpowiadasz.

Gdy masz już w panelu polecenie, komentarz lub załącznik, a wybierzesz inny post, odpowiedź albo zmienioną rozmowę, panel pokaże pasek **Przełącz**. Bieżący szkic zostaje przy swoim kontekście. Panel pomija wybory z innego okna przeglądarki.

Przed wstawieniem wtyczka ponownie odczytuje cel. Gdy pole zniknęło albo kontekst się zmienił, odmawia wstawienia i próbuje skopiować tekst do schowka. Kliknij ponownie właściwe pole na LinkedInie, sprawdź kontekst i szkic, a potem wstaw lub wklej tekst.

### Wiadomości

Kliknij w pole wiadomości w rozmowie, na pełnej stronie wiadomości albo w okienku czatu w prawym dolnym rogu. Panel przełączy się w tryb **Rozmowa**: pokaże, z kim rozmawiasz, ostatnią wiadomość, jej tłumaczenie i pomysły na odpowiedź.

- Do modelu trafia 10 ostatnich wiadomości z tej rozmowy. Twoje są oznaczone jako „Ja”. Możesz je poprawić w polu **Ostatnie wiadomości**.
- Odpowiedź powstaje w języku rozmówcy i odnosi się do jego ostatniej wiadomości. Model nie umawia spotkań, terminów ani cen w Twoim imieniu, jeśli o to nie poprosisz.
- **Wstaw do wiadomości** wkłada tekst do pola i nic nie wysyła. Kolejne linie są miękkimi złamaniami wiersza (jak Shift+Enter), bez naciskania Enter. Wiadomość wysyłasz przyciskiem LinkedIna.
- Twój styl w wiadomościach uczy się osobno od komentarzy.
- Gdy wtyczka nie rozpozna nagłówka okienka czatu, imię i profil rozmówcy bierze z jego wiadomości wśród 10 ostatnich.

LinkedIn pokazuje wiadomości na dwa sposoby i wtyczka obsługuje oba: pełna strona `/messaging/` działa w osobnej ramce (iframe), a okienka czatu w głównym oknie są w osadzonym fragmencie strony (shadow DOM). Odczyt rozmowy i wstawianie odpowiedzi w wersji 0.4.2 działają na prawdziwym LinkedInie (sprawdzone 2026-11-09). Jeśli LinkedIn zmieni budowę czatu i odczyt przestanie działać, przygotuj wynik sondy (niżej, „Gdy wtyczka źle odczytuje stronę”).

Karta **Kontekst** w kroku 1 pokazuje, co jeszcze trafia do modelu: opis autora, podlinkowany artykuł, komentarze innych osób (z autorem i początkiem treści) i (opcjonalnie) dane z Harmonic.

Gdy wtyczka źle odczyta post (LinkedIn często zmienia budowę strony), rozwiń **Pełny tekst posta** i popraw treść. Możesz też zaznaczyć tekst posta myszką i kliknąć **Użyj zaznaczonego tekstu**.

### Tłumaczenie zaznaczenia i komentarzy

- **Zaznaczony tekst:** zaznacz na LinkedInie dowolny fragment (post, komentarz, wiadomość, także w okienku czatu) i kliknij **Tłumacz** w górnym pasku panelu albo naciśnij **Alt+Shift+T**. Tekst w obcym języku wtyczka tłumaczy na polski, a tekst po polsku na angielski. Wynik pojawia się w karcie „Tłumaczenie zaznaczenia” razem z uwagami o idiomach i tonie. Karta nie zmienia wybranego posta i zostaje, gdy klikniesz pole pod innym postem.
- Do modelu trafia najwyżej 10 000 znaków zaznaczenia. Przy dłuższym karta mówi, że przetłumaczono tylko początek.
- **Komentarze innych osób:** w karcie **Kontekst** kliknij **Przetłumacz komentarze**. Tłumaczenie każdego komentarza pojawia się pod nim. Wtyczka tłumaczy tylko komentarze, które i tak odczytała razem z postem, i nie czyta niczego więcej ze strony.

### Historia

Przycisk **Historia** w górnym pasku pokazuje komentarze i odpowiedzi, które wstawiasz lub kopiujesz (do 100, najnowsze na górze). Możesz:

- szukać po treści, autorze posta i fragmencie posta, bez polskich znaków („lodz” znajdzie „Łódź”);
- zawęzić listę do komentarzy albo wiadomości;
- kliknąć tekst, żeby go rozwinąć, skopiować go albo otworzyć post na LinkedInie (link jest tylko przy postach z rozpoznanym adresem);
- usunąć wpis przyciskiem **Usuń** (od razu, bez pytania).

Historia powstaje tylko wtedy, gdy w ustawieniach jest włączone „Ucz się z komentarzy, które wstawiam lub kopiuję”. Wpis z rozmowy nie zawiera nic o rozmówcy.

### Szkice, wersje i przerwanie pracy

Własne polecenie, tekst odpowiedzi i pole „Popraw” zapisują się automatycznie. Ponowne otwarcie panelu odtwarza szkic dla tego samego posta, odpowiedzi na komentarz lub rozmowy. Błąd API i **Przerwij** zachowują ręczne zmiany oraz polecenie poprawki. Do 8 ostatnich wersji można przywrócić z listy albo przyciskiem **Cofnij poprawkę**.

Domyślnie szkice są przechowywane tylko w bieżącej sesji przeglądarki (do 20, dodatkowo ograniczone budżetem miejsca). Wyłączenie, aktualizacja lub przeładowanie rozszerzenia oraz restart przeglądarki czyszczą dane sesyjne. W ustawieniach **Szkice** można osobno włączyć trwały zapis własnych tekstów, ważny do 7 dni. Wygasłe kopie są usuwane przy uruchomieniu lub użyciu rozszerzenia. Wyłączenie tej opcji usuwa trwałe kopie; bieżące szkice sesyjne zostają.

Trwały szkic nie zawiera transkrypcji rozmówcy, postów źródłowych, kluczy API, historii zapytań, rozumowania ani obrazów. Nie jest częścią eksportu historii. Po restarcie wskaż ponownie właściwy post lub rozmowę. Po odzyskaniu szkicu poprawka zaczyna nowe zapytanie z aktualnym kontekstem; starej rozmowy z modelem nie utrwalamy. Obrazy trzeba dołączyć ponownie.

Podczas zadania pasek **Przerwij** zatrzymuje także oczekiwanie na obrazy i dane Harmonic. **Ponów** uruchamia nieudane zadanie ponownie, jeśli jego tekst i kontekst są nadal aktualne. Przerwane zapytanie może być płatne, nawet gdy dostawca nie zwrócił zużycia tokenów.

### Dokumenty, ankiety i własne obrazy

W kroku 1 rozwiń **Dokument, ankieta lub własne obrazy**:

- Przy rozpoznanej ankiecie odczytywane są pytanie i dostępne opcje, wraz z widocznymi wynikami. Nie są pobierane ukryte wyniki i nie jest oddawany głos.
- Przy rozpoznanym dokumencie panel pokazuje tytuł, znaną liczbę stron i dostępne obrazy stron. Zaznacz, które uwzględnić. Model dostaje najwyżej 6 obrazów łącznie z ręcznymi załącznikami; ręcznie dodane obrazy mają pierwszeństwo.
- Możesz dodać własne zrzuty stron lub slajdy jako PNG, JPG, WebP albo GIF (po 3,5 MB, łącznie do 12 MB). Działa to także bez tekstu posta. Załączniki trafiają do modelu dopiero przy analizie lub pisaniu.
- Informacja o zakresie mówi, czy model dostał obrazy, sam opis, niepełną ankietę lub czy nie udało się pobrać części obrazów. Przy wideo otrzymuje opis i ewentualne obrazy, bez nagrania, dźwięku i napisów.

Rozpoznawanie dokumentów i ankiet jest sprawdzone na atrapach DOM, a nie na bieżącej wersji LinkedIna. Jeśli układ strony nie pasuje, użyj ręcznych zrzutów albo przygotuj sondę opisaną niżej. Rozszerzenie nie pobiera PDF, nie przewija karuzeli i nie klika odtwarzania.

### Skróty klawiszowe

| Skrót | Działanie |
|---|---|
| Alt+Shift+L | Otwiera panel wtyczki. |
| Alt+Shift+T | Otwiera panel i tłumaczy tekst zaznaczony na karcie LinkedIna. |
| Ctrl+Enter | W polu polecenia: pisze komentarz. |

Skróty zmienisz w `edge://extensions/shortcuts` (w Chrome: `chrome://extensions/shortcuts`). Edge i Chrome używają Alt+Shift+T do przejścia na pasek narzędzi. Jeśli skrót nie tłumaczy, sprawdź na tej stronie, czy jest przypisany do wtyczki, albo ustaw inny, np. Alt+Shift+Y.

## Ustawienia

| Ustawienie | Działanie |
|---|---|
| Dostawca, klucz, model | Sonnet 5.5 jest szybszy i tańszy, Opus 5.5 staranniejszy. Po wybraniu „Inny model…” wpiszesz dowolny identyfikator modelu. |
| Pisanie i poprawki | Effort i rozumowanie dla pisania komentarza lub odpowiedzi, poprawek i „Konkretniej”. Zmiana działa od następnego „Napisz komentarz”, bo poprawki jednego komentarza muszą iść z tymi samymi ustawieniami. |
| Analiza, tłumaczenia i kontrola | Effort i rozumowanie dla tłumaczenia posta i pomysłów, tłumaczeń, kontroli jakości i nauki stylu. |
| Effort | „Niska” jest najszybsza i wystarcza do komentarzy. „Bardzo wysoka” i „Maksymalna” dają najstaranniejszy tekst, ale trwają dłużej (wtyczka czeka do 5 minut) i kosztują więcej. „Domyślna modelu” nie wysyła parametru: Sonnet pracuje wtedy na wysokim, Opus na średnim. |
| Rozumowanie | „Automatyczne”: model sam decyduje, ile myśleć. „Wyłączone” przyspiesza odpowiedź, ale działa tylko z Sonnet 5.5 przy effort do „Wysoka”. Przy Opusie i przy wyższym effort ta opcja jest nieaktywna. |
| Pokaż tok rozumowania | Pod tłumaczeniem posta i pod komentarzem pojawia się zwinięte „Jak myślał model”: streszczenie rozumowania. Nie kosztuje więcej, bo model i tak myśli. Przy rozumowaniu „Wyłączone” nie ma czego pokazać. |
| O mnie | Model korzysta z tych informacji tylko wtedy, gdy pasują do posta, i nie dopisuje faktów spoza nich. |
| Język komentarza | Domyślnie język posta, do wyboru angielski albo polski. |
| Od razu tłumacz post | Po wybraniu posta od razu przychodzą tłumaczenie i pomysły. Po wyłączeniu robisz to przyciskiem. |
| Grafika z posta | Obraz trafia do modelu. Przydaje się, gdy na grafice są daty, miejsca albo nazwiska. |
| Twój styl | Wtyczka zapamiętuje lokalnie komentarze i odpowiedzi w wiadomościach, które wstawiasz lub kopiujesz, i pokazuje modelowi ostatnie jako wzór. Po 3 tekstach poprawionych ręcznie uczy się listy Twoich preferencji, osobno dla komentarzy i wiadomości. Obie listy możesz edytować. „Wyczyść historię” usuwa zapamiętane teksty. |
| Szkice | Opcjonalny trwały zapis własnych tekstów do 7 dni. Bez tej opcji szkice zostają tylko w sesji przeglądarki. |
| Harmonic | Po wpisaniu klucza API Harmonic panel pokazuje etap, finansowanie, wielkość zespołu i inwestorów firmy autora (albo rozmówcy) oraz jego rolę. |

### Ton, długość i kontekst o Tobie

Te ustawienia pełnią różne role:

| Źródło | Do czego służy |
|---|---|
| Polecenie lub szkic | Określa, co chcesz powiedzieć w tym konkretnym tekście. |
| „O mnie” | Dostarcza fakty o Tobie, używane wtedy, gdy pasują do posta lub rozmowy. |
| Twój styl | Przykłady i preferencje kształtują słownictwo oraz rytm; komentarze i wiadomości mają osobną pamięć. |
| Ton i długość w panelu | Określają formę bieżącego tekstu i mają pierwszeństwo przed zapisanymi wskazówkami stylu. |

Ton i długość wybierasz przy komentarzu lub wiadomości. Wtyczka zapamiętuje ostatni wybór. Gdy zmienisz je już po napisaniu, kliknij **Popraw** (pole może zostać puste), a model dostanie nowe ustawienia.

Pierwszeństwo tonu i długości obejmuje też wskazówki pisania wpisane w „O mnie”. Fakty z tego pola pozostają kontekstem, używanym tam, gdzie pasuje do posta lub rozmowy. Zapisana zmiana „O mnie” albo preferencji stylu działa od następnej poprawki; zapytanie już w toku korzysta z ustawień z chwili jego uruchomienia. Długość jest poleceniem dla modelu, a nie automatycznym przycinaniem wyniku.

| Długość | Komentarz | Wiadomość |
| --- | --- | --- |
| Krótka | 1–2 zdania | 1–3 zdania |
| Średnia | 3–4 zdania | Jeden krótki akapit |
| Dłuższa | Jeden akapit, najwyżej 6 zdań | Dwa krótkie akapity |

Zmiana „O mnie” lub preferencji wymaga **Zapisz ustawienia**. Potem wpisz polecenie poprawki albo zmień ton lub długość i kliknij **Popraw**. Sam zapis ustawień nie przepisuje gotowego tekstu. Model, dostawca, effort i rozumowanie pozostają takie jak przy rozpoczęciu danej rozmowy z modelem; ich zmiana działa od kolejnego **Napisz komentarz** lub **Napisz odpowiedź**. Poprawiony klucz API działa też w następnej poprawce.

Przy OpenRouterze wtyczka wysyła effort i rozumowanie tak samo jak do Anthropic. Nie wiadomo, czy OpenRouter je przekazuje. Jeśli zwróci błąd 400, ustaw w obu grupach effort „Domyślna modelu” i rozumowanie „Automatyczne” oraz wyłącz „Pokaż tok rozumowania”. Komunikat błędu podpowiada, którą z tych zmian zrobić.

Ustawienia zapisane przed wersją 0.5.0 miały jeden effort. Po aktualizacji obie grupy dostają tę samą wartość.

### „O mnie” z pliku lokalnego

Żeby nie wklejać „O mnie” po każdej instalacji, wpisz je w `local-config/defaults.json` (wzór: `local-config/defaults.example.json`). Plik nie trafia do Gita, a `npm run build` kopiuje go do `dist/defaults.json`.

- Przy pierwszym otwarciu panelu wtyczka wpisuje tekst w puste pole „O mnie”. Tekstu, który już tam jest, ani innych ustawień nie zmienia.
- Dzieje się to raz w danym profilu przeglądarki. Jeśli wyczyścisz pole ręcznie, tekst nie wróci.
- Plik może zawierać tylko pola `aboutMe`, `provider`, `models`, `effort`, `commentLanguage`, `tone` i `length`. `effort` ustawia obie grupy. **Klucze API są pomijane** i nigdy nie trafiają do `dist/`.

### Kopia zapasowa

W ustawieniach, w sekcji **Kopia zapasowa i przeniesienie**:

- **Eksportuj do pliku** zapisuje w folderze pobranych plików `asystent-linkedin-kopia-RRRR-MM-DD.json`. Plik zawiera zapisane ustawienia, „O mnie”, Twój styl (preferencje) i historię.
- Klucze API (Anthropic, OpenRouter, Harmonic) trafiają do pliku tylko po zaznaczeniu **Dołącz klucze API**. Są tam zwykłym tekstem, więc takiego pliku nie wysyłaj nikomu i usuń go po imporcie.
- **Importuj z pliku** najpierw pokazuje, co się zmieni, np. „Historia: 87 wpisów w pliku, w tym 12 nowych”. Nic się nie zmienia przed kliknięciem **Zastosuj**.
- Import zastępuje ustawienia, „O mnie” i Twój styl. Klucz, którego nie ma w pliku, zostaje taki jak teraz. Historię łączy z obecną: przy tym samym poście wygrywa nowszy wpis, łącznie do 100.
- Kopia to przeniesienie albo zabezpieczenie, a nie synchronizacja. Wpis usunięty z historii wróci, jeśli zaimportujesz starszy plik, w którym jeszcze był.

### Kontrola jakości

Po każdej wersji komentarza panel sprawdza go na dwa sposoby:

- od razu, bez modelu: ogólniki („Great post!”, „Świetny post”), zwroty typowe dla AI, myślniki, hashtagi, emoji i komentarz złożony prawie wyłącznie ze słów posta;
- modelem: czy komentarz coś wnosi, czy pasuje pod dowolny post, czy dopisuje fakty o Tobie spoza Twojego polecenia i „O mnie” oraz czy ma błędy językowe.

Ostrzeżenie nie blokuje wstawienia. Po ręcznej zmianie tekstu kliknij **Sprawdź ponownie**. Tłumaczenie zwrotne zostaje oznaczone jako nieaktualne: przycisk **Odśwież tłumaczenie** tłumaczy tylko aktualny tekst odpowiedzi, bez ponownego wysyłania rozmowy. Niepełny lub nieprawidłowy wynik API oznacza brak poprawnego sprawdzenia. Komunikat „Model nie wykrył problemów” dotyczy konkretnej wersji tekstu i nie jest gwarancją poprawności.

### Harmonic

Harmonic jest opcjonalny. Włączasz go w ustawieniach i wpisujesz klucz API Harmonic (wymaga planu z dostępem do API). Wtyczka pyta Harmonic o firmę albo osobę po adresie profilu autora na LinkedInie. Do modelu trafiają tylko publiczne fakty, a prompt zabrania cytowania liczb i inwestorów, których nie ma w poście. Listy i notatki Twojego zespołu nie są używane.

Uwaga: wtyczka korzysta z API Harmonic w kształcie opisanym w dokumentacji integracji firm trzecich (`POST /companies`, `POST /persons`, nagłówek `apikey`). Oficjalnej dokumentacji nie dało się pobrać. Jeśli Harmonic zwróci błąd, panel pokaże go w karcie Kontekst.

### Styl językowy

Prompt zawiera dwa krótkie zestawy reguł stylu. Model stosuje ten, który pasuje do języka tekstu:

- **angielski**, dla komentarzy, na podstawie [humanizer](https://github.com/blader/humanizer): bez „Great post!”, „delve”, „game-changer”, kontrastów typu „It's not just X, it's Y” i zakończeń typu „Exciting times ahead”;
- **polski**, dla komentarzy po polsku, tłumaczeń, pomysłów i uwag, na podstawie [miodkuj](https://github.com/bartekpucek/miodkuj): bez „warto zauważyć”, „kluczowy”, „dokonać”, stylu rzeczownikowego i kalk z angielskiego.

Tłumaczenie zwrotne nie podlega polskim regułom. Ma wiernie oddawać angielski komentarz, nawet jeśli brzmi sztywno, bo dzięki niemu sprawdzasz, co publikujesz.

### Koszt

Panel szacuje koszt bieżącego posta lub rozmowy na podstawie tokenów zwróconych przez API i stawek zapisanych w [`src/lib/pricing.js`](src/lib/pricing.js). W **Koszt i czas poszczególnych zadań** znajdziesz użyty model, czas, tokeny wejściowe i wyjściowe oraz odczyt i zapis cache. Szacunek korzysta z modelu podanego w odpowiedzi API, a gdy go brakuje, z konfiguracji danego zapytania.

Analiza, pisanie, poprawki, tłumaczenia, kontrola jakości i nauka stylu to osobne wywołania. Dodatkowe obrazy oraz tokeny zwiększają koszt. Przy nieznanej cenie modelu panel oznacza koszt jako nieznany; przerwanie zadania nie oznacza, że dostawca go nie naliczy. Szacunek w panelu nie zastępuje rozliczenia dostawcy.

Identyczna analiza może wrócić z pamięci panelu bez nowego wywołania API. **Przeanalizuj ponownie** wymusza świeże zapytanie.

## Prywatność i bezpieczeństwo

- Wtyczka **nigdy nie publikuje sama**, tylko wstawia tekst do pola. Wiadomości również wysyłasz samodzielnie.
- Wtyczka **niczego nie dokłada do strony LinkedIna** ani nie zmienia jej wyglądu. Strona się zmienia tylko wtedy, gdy klikniesz w panelu „Wstaw” albo „Rozwiń pełny tekst”.
- Czyta tylko post albo rozmowę, w której polu klikniesz, albo tekst, który zaznaczysz lub wkleisz. Nie przegląda skrzynki wiadomości.
- Wybrany post lub rozmowa, w tym do 10 ostatnich wiadomości i dane rozmówcy, są przechowywane w pamięci sesyjnej rozszerzenia (`chrome.storage.session`). Sam odczyt pola nie wywołuje API. Wywołania wykonuje panel; przy włączonej automatycznej analizie następują po wybraniu kontekstu albo odtworzeniu go przy otwarciu panelu.
- Trwałe szkice zawierają własne polecenia, odpowiedzi, tłumaczenia i wersje. Nie zapisują kopii posta źródłowego, transkrypcji, osobnych danych rozmówcy, historii zapytań do modelu, kluczy ani obrazów. Własny tekst może zawierać imię lub cytat, jeśli jest częścią Twojej odpowiedzi albo polecenia.
- Wstawianie do wiadomości nie naciska Enter i nie wysyła formularza. Gdy panel jest zamknięty, skrypt nadal może odczytać pole, w którym klikniesz, ale nie wysyła tego kontekstu do modelu.
- Treść posta trafia do modelu jako materiał do przeczytania, a prompt każe ignorować polecenia ukryte w poście. To ogranicza ryzyko, ale go nie wyklucza, dlatego zawsze czytasz komentarz przed publikacją.
- Panel pokazuje tekst z LinkedIna i od modelu jako zwykły tekst, nie jako HTML.
- Historia Twoich komentarzy i odpowiedzi (łącznie do 100) leży w pamięci lokalnej wtyczki. Wpis komentarza zawiera też autora i fragment posta. Wpis wiadomości zachowuje własną odpowiedź i polecenie; pola autora i fragmentu źródłowej rozmowy zostają puste. Przy włączonej pamięci stylu ostatnie własne teksty danego rodzaju trafiają do modelu jako przykłady.
- Analiza, pisanie, tłumaczenia, kontrola jakości i nauka stylu korzystają z promptu systemowego zawierającego zapisane **O mnie**. Zależnie od zadania dochodzi wybrany post, fragment rozmowy, tekst do tłumaczenia lub zaznaczone obrazy. Preferencje stylu są dołączane przy pisaniu i poprawkach.
- Tłumaczenie zaznaczenia uruchamiasz przyciskiem **Tłumacz** albo skrótem Alt+Shift+T. Wysyła wybrany fragment do 10 000 znaków wraz z promptem systemowym, bez całej rozmowy. Tłumaczenie komentarzy korzysta z treści odczytanych już razem z postem.
- Plik kopii zapasowej zawiera „O mnie”, Twój styl i historię (Twoje komentarze i fragmenty postów). Klucze API są w nim tylko po zaznaczeniu „Dołącz klucze API”. Trzymaj go jak prywatny dokument.
- Klucz API leży w pamięci lokalnej wtyczki (`chrome.storage.local`) w tym profilu przeglądarki. Nie synchronizuje się z kontem Microsoft i trafia tylko do wybranego dostawcy. Nie jest szyfrowany, więc nie instaluj wtyczki w profilu, z którego korzystają inne osoby.

## Aktualizacja i wersje

Jeśli korzystasz z kopii repozytorium, pobierz aktualną wersję i zbuduj rozszerzenie:

```bash
git pull --ff-only
npm ci
npm run build
```

Potem w `edge://extensions` (albo `chrome://extensions`) kliknij **Załaduj ponownie** przy wtyczce i odśwież otwarte karty LinkedIna. Przy zmianie lokalnego kodu wystarczy ponowny build i przeładowanie.

Przeładowanie rozszerzenia czyści szkice sesyjne. Przed aktualizacją skopiuj ważny tekst albo włącz trwały zapis szkiców w ustawieniach. Ustawienia i historia pozostają w pamięci lokalnej.

Numer wersji ma postać `MAJOR.MINOR.PATCH` i jest widoczny w `edge://extensions`. Zmieniasz go jednym poleceniem, które aktualizuje `package.json` i `src/manifest.json`:

```bash
npm version patch --no-git-tag-version   # poprawka, np. naprawiony odczyt posta
npm version minor --no-git-tag-version   # nowa funkcja albo zmiana zachowania
```

Opcja `--no-git-tag-version` sprawia, że npm nie tworzy własnego commita ani tagu. Nowy numer, wpis w `CHANGELOG.md` i zmiany w kodzie trafiają do jednego commita. Build zatrzymuje się, gdy numery w `package.json` i manifeście się różnią.

Sama dokumentacja i testy nie wymagają zmiany numeru wersji. Reguły wydań opisuje [`CLAUDE.md`](CLAUDE.md#wersje).

## Przeniesienie na inny komputer

Wtyczka nie ma konta ani synchronizacji. Na nowy komputer przenosisz dwie rzeczy: samą wtyczkę (wariant A albo B) i swoje dane (plik kopii zapasowej).

**Wariant A, bez Node.js i bez kodu:**

1. Skopiuj folder `dist/` (np. `C:\code\linkedin_plugin\dist`) w stałe miejsce na nowym komputerze, np. `C:\Narzędzia\asystent-linkedin`.
2. W Edge otwórz `edge://extensions`, włącz **Tryb dewelopera**, kliknij **Załaduj rozpakowane** i wskaż ten folder.
3. Nie usuwaj ani nie przenoś folderu: Edge ładuje wtyczkę bezpośrednio z niego. Aktualizacja to podmiana zawartości folderu i **Załaduj ponownie**.

Jeśli podczas budowania użyto własnego `local-config/defaults.json`, folder `dist/` zawiera też Twoje „O mnie” (bez kluczy API). Przy pierwszym otwarciu panel sam je wpisze. Takiego folderu nie dawaj innym osobom.

**Wariant B, z kodu (gdy chcesz budować i aktualizować wtyczkę na nowym komputerze):**

1. Zainstaluj Node.js 20 lub nowszy i Git z dostępem do repozytorium.
2. Pobierz kod i biblioteki: `git clone git@github.com:auditlog/linkedin-comment-assistant.git`, potem `cd linkedin-comment-assistant` i `npm ci`.
3. Jeśli korzystasz z własnych ustawień domyślnych, skopiuj ze starego komputera `local-config/defaults.json` do folderu `local-config/` nowej kopii. Możesz też pominąć ten krok i wpisać „O mnie” w panelu albo wczytać kopię zapasową.
4. Uruchom `npm run build`. Dopiero ten krok przenosi „O mnie” z `local-config/defaults.json` do `dist/defaults.json`.
5. Załaduj `dist/` w Edge jak w krokach 2–3 sekcji [Instalacja](#instalacja).

**W obu wariantach:** na starym komputerze kliknij w ustawieniach **Eksportuj do pliku**, a na nowym **Importuj z pliku** (sekcja [Kopia zapasowa](#kopia-zapasowa)). Klucze API wpisz na nowym komputerze ponownie albo dołącz je do eksportu i usuń plik po imporcie.

| Plik lub folder | Co zawiera | Kopiować? |
|---|---|---|
| `dist/` | gotowa wtyczka i `defaults.json` z „O mnie” | tak, w wariancie A |
| `local-config/defaults.json` | „O mnie” i ustawienia domyślne, bez kluczy | tak, w wariancie B |
| `asystent-linkedin-kopia-….json` | ustawienia, styl, historia, opcjonalnie klucze | tak, w obu wariantach; usuń po imporcie |
| kod z repozytorium | źródła wtyczki | w wariancie B przez `git clone`, nie kopiuj ręcznie |
| `node_modules/` | biblioteki do budowania | nie, `npm ci` pobierze je ponownie |
| `.cache/` | wyniki sond i biblioteki do testów | nie |

## Rozwój

```
local-config/   prywatne ustawienia domyślne (poza Gitem)
src/
  background.js           otwiera panel, przechowuje kontekst i obsługuje zapis szkiców
  content/content.js      tryb podążania za klikniętym polem, wstawianie tekstu
  content/linkedin-dom.js odczyt posta ze strony LinkedIna
  content/linkedin-messaging.js odczyt rozmowy (wiadomości)
  content/linkedin-media.js odczyt dokumentów i ankiet w wybranym poście
  sidepanel/              panel boczny
  lib/                    kontekst i rewizje (context), operacje (operations), szkice (drafts),
                          media i załączniki (media), prompty, reguły stylu, Twój styl (voice), kontrola jakości (quality),
                          historia (history.js), kopia zapasowa (backup.js),
                          Harmonic, wywołania API, ustawienia, ceny
test/unit/      testy jednostkowe (node:test)
test/e2e/       test całości w Chromium z atrapą LinkedIna (feed, strona wiadomości w ramce,
                okienko czatu w shadow DOM, dokumenty i ankiety) i API
test/eval/      syntetyczne przypadki oceny modelu i rubryki oceny ręcznej
scripts/        ikony, wersja, wyszukiwanie Chromium, sonda struktury LinkedIna (diagnose-linkedin.js),
                uruchamianie oceny modelu (evaluate.mjs)
```

Gdy LinkedIn zmieni budowę strony i wtyczka przestanie odczytywać posty, zacznij od list selektorów na górze `src/content/linkedin-dom.js`. Przy wiadomościach: `src/content/linkedin-messaging.js`.

### Gdy wtyczka źle odczytuje stronę

LinkedIn często zmienia budowę strony. Żeby poprawić odczyt, potrzebna jest struktura strony, ale bez treści rozmów. Służy do tego `scripts/diagnose-linkedin.js`:

1. Na LinkedInie kliknij w pole, które nie działa (komentarz albo wiadomość), tak żeby był w nim kursor.
2. Naciśnij F12 i przejdź do zakładki **Console**. Przy pierwszym wklejaniu Edge poprosi o wpisanie `allow pasting`.
3. Wklej całą zawartość `scripts/diagnose-linkedin.js` i naciśnij Enter. Wynik trafi do schowka. Kopiuj skrypt za każdym razem z pliku, bo zmienia się razem z wtyczką.
4. Wklej wynik do nowego pliku, np. `C:\code\linkedin_plugin\.cache\probe-wiadomosci-3.txt` (folder `.cache` jest poza Gitem), i napisz, co pokazał panel.

Wynik zawiera tylko nazwy elementów i klas, techniczne identyfikatory elementów (`data-testid`), układ strony, adresy ramek bez parametrów i długości tekstów. Nie zawiera treści wiadomości, imion, linków ani identyfikatorów rozmów. Gdy kursor jest w ramce (pełna strona wiadomości) albo w osadzonym fragmencie strony (okienko czatu), skrypt sam do nich wchodzi. Przed przekazaniem możesz wynik przeczytać.

Pierwsza linia wyniku mówi, co sonda opisała: `mode: post` (kursor w polu komentarza, opis całego posta razem z obrazami, wideo i napisami jako samymi znacznikami, bez adresów) albo `mode: nearby` (np. pole wiadomości).

**Posty z dokumentem, wideo i ankietą:** od 0.7.0 istnieje ostrożny odczyt rozpoznanych dokumentów i ankiet. Do potwierdzenia lub dostosowania go na prawdziwym LinkedInie nadal przydają się trzy wyniki sondy:

1. Znajdź w feedzie post z dokumentem (karuzela ze stronami PDF), kliknij pole komentarza pod nim, uruchom sondę i zapisz wynik w `.cache\probe-dokument.txt`.
2. To samo pod postem z wideo: `.cache\probe-wideo.txt`.
3. To samo pod postem z ankietą: `.cache\probe-ankieta.txt`.

Przy każdym wyniku napisz, co widać w poście (np. „dokument, 8 stron, tytuł na pierwszej stronie”), bez kopiowania treści.

### Testy

```bash
npm test            # testy jednostkowe
npm run test:e2e    # build i test w Chromium, bez kosztów i bez klucza API
npm run eval        # opis syntetycznych przypadków, bez wywołań API
```

Testy E2E używają tymczasowego profilu przeglądarki, fikcyjnych ustawień i atrap API. Sześć przypadków sprawdza wszystkie długości dla komentarzy i wiadomości razem z „O mnie” i pamięcią stylu. Kolejne sprawdzają zmianę profilu przed poprawką oraz odtworzony szkic wiadomości. Do atrap API trafiają syntetyczne wartości „O mnie”. Testy nie mierzą, czy rzeczywisty model zachowa wybraną długość lub ton.

Test E2E ładuje wtyczkę w Chromium pobranym przez Playwright (`~/.cache/ms-playwright`) albo w przeglądarce ze zmiennej `CHROMIUM_PATH`. Jeśli w WSL brakuje bibliotek NSS, pobierz je bez uprawnień administratora:

```bash
mkdir -p .cache/chromium-libs/debs && cd .cache/chromium-libs/debs
apt-get download libnspr4 libnss3
for f in *.deb; do dpkg -x "$f" ../root; done
```

Zrzuty ekranu panelu do przeglądu: `LCA_SCREENSHOTS=/ścieżka/do/folderu npm run test:e2e`.

### Ocena jakości modelu

`npm run eval` opisuje zestaw 34 syntetycznych przypadków i niczego nie wysyła. Obejmuje komentarze, DM, konflikty długości i tonu z profilem i stylem, tłumaczenia oraz wykrywanie niepopartych faktów i zobowiązań. To osobny zestaw od testów E2E z gotowymi odpowiedziami API.

- `npm run eval -- --from plik.json` sprawdza zapisane odpowiedzi: tablicę obiektów `{id, text}` albo wcześniejszy raport z polem `records`. Identyfikatory przypadków znajdziesz w [`test/eval/cases.js`](test/eval/cases.js).
- `npm run eval -- --run --limit 4` uruchamia **płatne** wywołania API. Klucz podaj w zmiennej środowiskowej `ANTHROPIC_API_KEY` lub `OPENROUTER_API_KEY`; skrypt nie czyta ustawień przeglądarki ani plików prywatnych. Dostawcę i model wybierają opcje `--provider` i `--model`.
- `--limit N` wybiera pierwsze N przypadków z [`test/eval/cases.js`](test/eval/cases.js). Bez limitu próba obejmuje cały zestaw. Pierwsze cztery przypadki nie obejmują konfliktów stylu z profilem.
- Raport domyślnie trafia do `.cache/eval-results.json`. Kontrole mechaniczne sprawdzają format, wymagane nazwy/liczby, wybrane niepożądane obietnice, długość i rodzaj ostrzeżenia. Każdy przypadek ma rubrykę do ręcznej oceny sensu, wierności i stylu. Wynik mechaniczny nie zastępuje takiej oceny.

## Źródła i licencje

Reguły stylu w `src/lib/style-rules.js` to skróty dwóch projektów na licencji MIT:

- **miodkuj**: © 2026 Bartek Pucek, https://github.com/bartekpucek/miodkuj;
- **humanizer**: blader, https://github.com/blader/humanizer, oparty na [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
