/**
 * Odtwarzacz partytury chóralnej: renderowanie nut przez OpenSheetMusicDisplay (OSMD)
 * + niezależny, własny odczyt pliku MusicXML w celu zbudowania harmonogramu dźwięku
 * per głos (Sopran/Alt/Tenor/Bas), odtwarzanego przez soundfont-player.
 *
 * Dlaczego dwa niezależne odczyty tego samego pliku? OSMD renderuje partyturę na ekranie
 * (i ma swój wewnętrzny, nieudokumentowany model wysokości dźwięków), a my potrzebujemy
 * w pełni przewidywalnego, zgodnego ze specyfikacją MusicXML wyliczenia wysokości i czasu
 * nut do zaplanowania dźwięku — dlatego liczymy to sami wprost ze standardu (step/alter/
 * octave, divisions, backup/forward, chord). Kursor na partyturze jest synchronizowany
 * "najlepszym możliwym staraniem" (best-effort) publicznym API kursora OSMD.
 */

( function () {
	'use strict';

	var NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
	var LOOKAHEAD_SECONDS = 0.6;
	var SCHEDULER_TICK_MS = 120;
	var CURSOR_STEP_GUARD = 20000;
	// Głosy, których nazwa (z <part-name> w pliku MusicXML) wskazuje na akompaniament, a nie
	// właściwy głos chóralny — dostają domyślnie brzmienie fortepianu zamiast chóru (patrz
	// buildFlatNotes); można to zmienić ręcznie w mikserze, tak jak brzmienie każdego innego głosu.
	var ACCOMPANIMENT_PATTERN = /(fortepian|pianino|piano|akompaniament|accompaniment|organy|organ|keyboard|klawesyn|orkiestr|instrument)/i;

	var DEFAULT_VOICE_TIMBRE = 'choir_aahs';

	// Brzmienia dostępne do wyboru dla KAŻDEGO głosu z osobna (patrz buildVoiceControls) —
	// ta sama trójka, która wcześniej była jednym wspólnym wyborem dla całego utworu.
	var TIMBRE_OPTIONS = [
		{ value: 'choir_aahs', label: 'Chór (Aahs)' },
		{ value: 'voice_oohs', label: 'Chór (Oohs)' },
		{ value: 'acoustic_grand_piano', label: 'Fortepian' }
	];

	// Wartości rytmiczne (jako ułamek ćwierćnuty) używane przy zapasowym wykrywaniu tempa
	// z wizualnego oznaczenia metronomu <metronome> — patrz parseMusicXmlForPlayback.
	var BEAT_UNIT_QUARTERS = {
		whole: 4, half: 2, quarter: 1, eighth: 0.5,
		'16th': 0.25, '32nd': 0.125, '64th': 0.0625, '128th': 0.03125
	};

	document.addEventListener( 'DOMContentLoaded', function () {
		var containers = document.querySelectorAll( '.cnr-player' );
		Array.prototype.forEach.call( containers, setupPlayer );
	} );

	function setupPlayer( container ) {
		var fileUrl = container.getAttribute( 'data-file-url' );
		var format  = container.getAttribute( 'data-format' ) || 'musicxml';

		var scoreEl    = container.querySelector( '.cnr-player__score' );
		var statusEl   = container.querySelector( '.cnr-player__status' );
		var voicesEl   = container.querySelector( '.cnr-player__voices' );
		var playBtn    = container.querySelector( '.cnr-player__play' );
		var stopBtn    = container.querySelector( '.cnr-player__stop' );
		var controlsEl = container.querySelector( '.cnr-player__controls' );
		var collapseToggleBtn = container.querySelector( '.cnr-player__collapse-toggle' );
		var collapseIconEl = container.querySelector( '.cnr-player__collapse-icon' );
		var collapseLabelEl = container.querySelector( '.cnr-player__collapse-label' );
		var tempoInput = container.querySelector( '.cnr-player__tempo' );
		var tempoNumberInput = container.querySelector( '.cnr-player__tempo-number' );
		var backingTempoInput = container.querySelector( '.cnr-player__backing-tempo' );
		var backingTempoNumberInput = container.querySelector( '.cnr-player__backing-tempo-number' );
		var printBtn   = container.querySelector( '.cnr-player__print' );
		var progressBar = container.querySelector( '.cnr-player__progress-bar' );
		var masterVolInput = container.querySelector( '.cnr-player__master-volume' );
		var masterVolValue = container.querySelector( '.cnr-player__master-volume-value' );
		var audioUrl = container.getAttribute( 'data-audio-url' ) || '';

		// Własne brzmienia SoundFont (.sf2) — od 1.13.0, lista z ustawień wtyczki.
		var soundfonts = [];
		try {
			soundfonts = JSON.parse( container.getAttribute( 'data-soundfonts' ) || '[]' );
		} catch ( e ) {
			soundfonts = [];
		}
		soundfonts = ( Array.isArray( soundfonts ) ? soundfonts : [] ).filter( function ( sf ) {
			return sf && sf.id && sf.url;
		} );

		setupCollapseToggle( controlsEl, collapseToggleBtn, collapseIconEl, collapseLabelEl );

		if ( ! fileUrl ) {
			setStatus( statusEl, 'Brak pliku nut do wyświetlenia.', true );
			return;
		}

		if ( typeof opensheetmusicdisplay === 'undefined' ) {
			setStatus( statusEl, 'Nie udało się wczytać biblioteki do wyświetlania nut (OpenSheetMusicDisplay). Sprawdź połączenie internetowe strony.', true );
			return;
		}

		setStatus( statusEl, 'Wczytywanie partytury…', false );

		var osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay( scoreEl, {
			// Zmianę szerokości obsługujemy sami (rerenderScore) — razem z dopasowaniem rozmiaru
			// nut i przywróceniem kursora; telefony zgłaszają „resize” także przy chowaniu paska
			// adresu podczas przewijania, a wtedy niczego nie trzeba przeliczać.
			autoResize: false,
			drawTitle: true,
			// Bez wbudowanego „followCursor” OSMD: przy każdym kroku kursora wołał on
			// scrollIntoView({block: 'center'}) — dla wysokiego systemu (chór + fortepian)
			// górna pięciolinia lądowała pod przyklejonym paskiem odtwarzacza, a do tego
			// przewijanie walczyło z naszym (maybeAutoScrollToCursor). Od 1.14.1 przewija tylko
			// odtwarzacz.
			followCursor: false,
			// Jawnie ustawiony wygląd kursora (zamiast domyślnego, bardzo cienkiego): kolorowy
			// prostokąt podświetlający aktualnie odtwarzane nuty (CursorType.Standard = 0),
			// żeby śledzenie w nutach było wyraźnie widoczne.
			cursorsOptions: [ { type: 0, color: '#3a7bd5', alpha: 0.4, follow: false } ]
		} );

		var player = {
			container: container,
			osmd: osmd,
			schedule: null,
			flatNotes: [],
			voiceStates: {},
			audioCtx: null,
			instrumentCache: {},
			isPlaying: false,
			isPaused: false,
			playStartAudioTime: 0,
			playStartQuarters: 0,
			scheduleIndex: 0,
			schedulerTimer: null,
			cursorSteps: [],
			notePositions: [],
			cursorCallsMade: 0,
			tempoMultiplier: 1,
			baseBpm: 120,
			masterVolume: 1,
			masterGainNode: null,
			// Metronom i odliczanie przed startem (od 1.15.0) — wybór zapamiętany w przeglądarce.
			metronome: '1' === storageGet( METRONOME_STORAGE_KEY ),
			countIn: '1' === storageGet( COUNT_IN_STORAGE_KEY ),
			clickIndex: 0,
			// Rozmiar nut (od 1.15.1): '' = automatycznie wg szerokości ekranu, albo liczba.
			zoomPref: parseFloat( storageGet( ZOOM_STORAGE_KEY ) ) || 0,
			highlightLeadMs: readLeadPref(),
			renderedWidth: 0,
			clickNodes: [],
			countInTimer: null,
			scrollCooldownUntil: 0,
			lastScrollTargetY: null,
			audioEl: null,
			audioTrackGain: null,
			backingTrack: { muted: false, solo: false, volume: 1, tempoMultiplier: 1 },
			soundfonts: soundfonts,
			banks: {},        // id SoundFontu -> wczytany bank (CNR.SoundFont)
			// Konkretne domyślne brzmienia z ustawień wtyczki (od 1.14.0): osobno głosy chóralne
			// i akompaniament. Starszy szablon (1.13.0) podawał tylko grupę — data-default-sound.
			defaults: readDefaults( container, soundfonts ),
			soundSource: initialSoundSource( soundfonts ),
			statusEl: statusEl,
			voicesEl: voicesEl
		};

		setupStickyOffset( player );
		setupMetronomeControls( player );
		setPlayLabel( playBtn, false );
		setIconLabel( stopBtn, '■', 'Zatrzymaj' );
		setupZoomControls( player );
		setupLeadControl( player );
		setupAudioLifecycle( player );

		if ( audioUrl ) {
			// Podkład instrumentalny (opcjonalny plik audio zsynchronizowany z nutami po nazwie
			// pliku — patrz CNR_Drive_Sync::sync_audio_file w PHP). Nie dodajemy go do DOM —
			// element <audio> działa poprawnie i odtwarza dźwięk również "odłączony" od strony,
			// wystarczy trzymać do niego referencję w JS.
			player.audioEl = document.createElement( 'audio' );
			player.audioEl.src = audioUrl;
			player.audioEl.preload = 'auto';
			applyAudioPreservesPitch( player.audioEl );
		}

		Promise.all( [
			osmd.load( fileUrl ).then( function () {
				osmd.Zoom = effectiveZoom( player );
				osmd.render();
				player.renderedWidth = scoreEl ? scoreEl.clientWidth : 0;
				updateZoomLabel( player );
			} ),
			fetchRawMusicXmlText( fileUrl, format )
		] )
			.then( function ( results ) {
				var xmlText = results[ 1 ];
				var schedule = parseMusicXmlForPlayback( xmlText );

				if ( ! schedule.voices.length ) {
					setStatus( statusEl, 'Partytura wyświetlona, ale nie udało się odczytać nut do odtworzenia dźwięku (odtwarzacz pokaże tylko zapis nutowy).', true );
				} else if ( ! schedule.bpmDetected ) {
					// Plik nie zawiera ani playbackowego <sound tempo>, ani wizualnego oznaczenia
					// metronomu z wartością — to jedyne dwa źródła, z których wtyczka umie odczytać
					// tempo, więc gdy autor partytury nie dodał żadnego z nich (np. zostawił sam
					// opisowy podpis typu „Allegro” bez liczby), nie da się go rozpoznać automatycznie.
					setStatus( statusEl, 'Nie wykryto tempa zapisanego w pliku nut — użyto domyślnego 120 BPM. Popraw je suwakiem „Tempo” powyżej, jeśli to nie jest właściwa wartość.', false );
				} else {
					setStatus( statusEl, '', false );
				}

				player.schedule = schedule;
				player.baseBpm  = schedule.bpm;
				buildFlatNotes( player );
				buildVoiceControls( voicesEl, player );
				buildBackingTrackControl( voicesEl, player );
				// Zapamiętany wybór chórzysty albo domyślne brzmienia z ustawień wtyczki.
				applySoundSource( player, player.soundSource );

				// Suwak tempa pokazuje i ustawia realne uderzenia na minutę (BPM), a nie procent —
				// zakres suwaka zależy od tempa bazowego z pliku nut, więc da się go poprawnie
				// ustawić dopiero teraz. Wewnętrznie nadal liczymy tempo jako mnożnik względem
				// baseBpm (patrz rebaseTempo/currentBpm) — zmienia się tylko to, jak suwak
				// przelicza wybraną wartość na ten mnożnik.
				var baseBpmRounded = Math.max( 1, Math.round( schedule.bpm ) );
				if ( tempoInput ) {
					tempoInput.min = Math.max( 20, Math.round( baseBpmRounded * 0.4 ) );
					tempoInput.max = Math.round( baseBpmRounded * 2 );
					tempoInput.step = 1;
					tempoInput.value = baseBpmRounded;
				}
				if ( tempoNumberInput ) {
					tempoNumberInput.value = baseBpmRounded;
				}

				// Tempo podkładu instrumentalnego jest CELOWO niezależne od tempa nut (patrz
				// rebaseBackingTempo) — np. żeby dało się przećwiczyć nuty wolniej, a podkład
				// (prawdziwe nagranie) zostawić w oryginalnym tempie. Oba suwaki startują od
				// tego samego tempa bazowego z pliku, ale każdy zmienia się osobno.
				if ( backingTempoInput ) {
					backingTempoInput.min = tempoInput ? tempoInput.min : Math.max( 20, Math.round( baseBpmRounded * 0.4 ) );
					backingTempoInput.max = tempoInput ? tempoInput.max : Math.round( baseBpmRounded * 2 );
					backingTempoInput.step = 1;
					backingTempoInput.value = baseBpmRounded;
				}
				if ( backingTempoNumberInput ) {
					backingTempoNumberInput.value = baseBpmRounded;
				}

				var built = buildCursorSteps( osmd );
				player.cursorSteps = built.steps;
				player.notePositions = built.positions;
				player.positionsOrigin = scoreOrigin( scoreEl );

				if ( scoreEl ) {
					scoreEl.style.cursor = 'pointer';
					scoreEl.title = 'Kliknij w nutę, żeby rozpocząć odtwarzanie od tego miejsca.';
				}

				enableControls( container, true );
			} )
			.catch( function ( err ) {
				console.error( 'Chór — Repertuar: błąd wczytywania utworu', err );
				setStatus( statusEl, 'Nie udało się wczytać pliku nut. Spróbuj odświeżyć stronę lub sprawdź plik w panelu administracyjnym.', true );
			} );

		playBtn.addEventListener( 'click', function () {
			if ( player.isPlaying ) {
				pausePlayback( player, playBtn );
				return;
			}

			// KLUCZOWE dla telefonów (zwłaszcza iOS Safari): kontekst audio trzeba
			// utworzyć i "wznowić" SYNCHRONICZNIE w reakcji na dotknięcie, zanim zacznie się
			// jakiekolwiek asynchroniczne ładowanie (np. pobieranie brzmienia instrumentu).
			// Jeśli resume() wywoła się dopiero w callbacku po Promise, przeglądarka mobilna
			// może uznać, że to już nie jest reakcja na gest użytkownika, i nigdy nie puścić
			// dźwięku — mimo braku jakiegokolwiek błędu w konsoli.
			var ac = unlockAudio( player );

			startPlayback( player, playBtn, progressBar ).then( function () {
				// Druga, kontrolna próba wznowienia — na części telefonów pierwsze resume()
				// wywołane przed zakończeniem ładowania próbek dźwięku i tak nie wystarcza.
				// iPhone po rozmowie, Siri albo powrocie z tła zostawia kontekst w stanie
				// „interrupted” (nie „suspended”) — sprawdzamy więc każdy stan inny niż „running”.
				if ( 'running' !== ac.state ) {
					ac.resume().catch( function () {} ).then( function () {
						setTimeout( function () {
							if ( 'running' !== ac.state ) {
								// Ten kontekst audio już nie ruszy — przy następnym dotknięciu
								// „Odtwórz” tworzymy nowy (patrz unlockAudio).
								player.audioNeedsReset = true;
								pausePlayback( player, playBtn );
								setStatus( statusEl, 'Telefon wstrzymał dźwięk — dotknij „Odtwórz” jeszcze raz.', true );
							}
						}, 400 );
					} );
				}
			} ).catch( function ( err ) {
				console.error( 'Chór — Repertuar: błąd odtwarzania', err );
				setStatus( statusEl, 'Nie udało się uruchomić dźwięku w przeglądarce.', true );
			} );
		} );

		stopBtn.addEventListener( 'click', function () {
			stopPlayback( player, playBtn, progressBar );
		} );

		setupTempoControl( tempoInput, tempoNumberInput, function () {
			return player.baseBpm;
		}, function ( bpm ) {
			rebaseTempo( player, bpm / player.baseBpm );
		} );

		// Celowo NIEZALEŻNE od suwaka/pola tempa nut powyżej (rebaseTempo) — patrz komentarz przy
		// rebaseBackingTempo i przy dynamicznym ustawianiu zakresu w Promise.all().then() wyżej.
		setupTempoControl( backingTempoInput, backingTempoNumberInput, function () {
			return player.baseBpm;
		}, function ( bpm ) {
			rebaseBackingTempo( player, bpm / player.baseBpm );
		} );

		if ( masterVolInput ) {
			masterVolInput.addEventListener( 'input', function () {
				var percent = parseInt( masterVolInput.value, 10 );
				if ( isNaN( percent ) ) {
					percent = 100;
				}
				if ( masterVolValue ) {
					masterVolValue.textContent = percent + '%';
				}
				player.masterVolume = percent / 100;
				if ( player.masterGainNode ) {
					player.masterGainNode.gain.value = player.masterVolume;
				}
			} );
		}

		if ( printBtn ) {
			printBtn.addEventListener( 'click', function () {
				window.print();
			} );
		}

		/* --- Spacja: odtwórz / pauza (jak w typowych odtwarzarkach audio/wideo) --- */
		document.addEventListener( 'keydown', function ( evt ) {
			if ( ' ' !== evt.key && 'Spacebar' !== evt.key && 32 !== evt.keyCode ) {
				return;
			}
			var target = evt.target;
			var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
			// Nie przechwytuj spacji, gdy użytkownik pisze w polu tekstowym, wybiera coś
			// w liście rozwijanej albo naciska inny przycisk (tam spacja ma swoje standardowe
			// znaczenie — np. "kliknij ten przycisk").
			if ( 'input' === tag || 'textarea' === tag || 'select' === tag || 'button' === tag || 'a' === tag || ( target && target.isContentEditable ) ) {
				return;
			}
			if ( ! player.schedule || playBtn.disabled ) {
				return;
			}
			evt.preventDefault();
			// Ponownie użyj istniejącej obsługi kliknięcia — dzięki temu spacja przechodzi przez
			// dokładnie tę samą, sprawdzoną ścieżkę (w tym synchroniczne wznowienie AudioContext
			// wymagane na telefonach). Naciśnięcie klawisza to również "gest użytkownika", więc
			// wznowienie dźwięku zainicjowane stąd działa tak samo jak po kliknięciu myszką.
			playBtn.click();
		} );

		/* --- Pasek postępu: przewijanie kliknięciem i przeciąganiem --- */
		if ( progressBar && progressBar.parentElement ) {
			var progressWrap = progressBar.parentElement;
			var seekingPointerId = null;

			var ratioFromEvent = function ( evt ) {
				var rect = progressWrap.getBoundingClientRect();
				if ( ! rect.width ) {
					return 0;
				}
				var ratio = ( evt.clientX - rect.left ) / rect.width;
				return Math.max( 0, Math.min( 1, ratio ) );
			};

			var handleProgressSeek = function ( evt ) {
				if ( ! player.schedule || ! player.schedule.totalQuarters ) {
					return;
				}
				var target = ratioFromEvent( evt ) * player.schedule.totalQuarters;
				seekToQuarters( player, target, playBtn, progressBar );
			};

			progressWrap.addEventListener( 'pointerdown', function ( evt ) {
				if ( ! player.schedule ) {
					return;
				}
				seekingPointerId = evt.pointerId;
				if ( progressWrap.setPointerCapture ) {
					try {
						progressWrap.setPointerCapture( evt.pointerId );
					} catch ( e ) {
						// ignorowane — przewijanie nadal zadziała, tylko bez "przechwycenia" wskaźnika.
					}
				}
				handleProgressSeek( evt );
				evt.preventDefault();
			} );

			progressWrap.addEventListener( 'pointermove', function ( evt ) {
				if ( null === seekingPointerId || evt.pointerId !== seekingPointerId ) {
					return;
				}
				handleProgressSeek( evt );
			} );

			[ 'pointerup', 'pointercancel' ].forEach( function ( type ) {
				progressWrap.addEventListener( type, function ( evt ) {
					if ( evt.pointerId === seekingPointerId ) {
						seekingPointerId = null;
					}
				} );
			} );
		}

		/* --- Kliknięcie w partyturę: rozpocznij odtwarzanie od tego miejsca --- */
		if ( scoreEl ) {
			scoreEl.addEventListener( 'click', function ( evt ) {
				if ( ! player.schedule || ! player.notePositions || ! player.notePositions.length ) {
					return;
				}
				// Kliknięcie przeliczamy na te same "dokumentowe" współrzędne co zapisane pozycje
				// nut (patrz getCursorRect) — inaczej porównanie byłoby błędne po każdym przewinięciu.
				var clickX = evt.clientX + window.scrollX;
				var clickY = evt.clientY + window.scrollY;
				// Pozycje nut zapisano raz, po wyrenderowaniu partytury — od tego czasu wszystko nad
				// nią mogło się przesunąć (mikser po wczytaniu brzmień, komunikat statusu, zwinięcie
				// panelu, przyklejony pasek…). Przeliczamy kliknięcie o to przesunięcie partytury;
				// wcześniej kliknięcie trafiało wtedy w inną linijkę albo w losowe miejsce.
				var origin = scoreOrigin( scoreEl );
				if ( player.positionsOrigin && origin ) {
					clickX -= origin.left - player.positionsOrigin.left;
					clickY -= origin.top - player.positionsOrigin.top;
				}
				var time = findNearestStepTime( player.cursorSteps, player.notePositions, clickX, clickY );
				if ( null !== time ) {
					// "time" to pozycja "papierowa" w zapisie (tak porusza się kursor OSMD) — jeśli
					// utwór ma powtórzenia, to samo miejsce na partyturze gra się więcej niż raz w
					// WYKONANIU utworu, więc przeliczamy na pozycję odtwarzania (patrz
					// mapRawToPerformed — celuje w pierwsze wykonanie danego miejsca).
					var performedTime = mapRawToPerformed( player.schedule && player.schedule.quartersMap, time );
					seekToQuarters( player, performedTime, playBtn, progressBar );
				}
			} );
		}

		/* --- Zmiana szerokości (obrót telefonu, zmiana okna): nowy układ nut i pozycje kursora --- */
		var resizeTimer = null;
		window.addEventListener( 'resize', function () {
			if ( resizeTimer ) {
				clearTimeout( resizeTimer );
			}
			resizeTimer = setTimeout( function () {
				// Telefony zgłaszają „resize” także przy chowaniu paska adresu w trakcie
				// przewijania — liczy się tylko zmiana szerokości partytury.
				if ( player.schedule && scoreEl && Math.abs( scoreEl.clientWidth - player.renderedWidth ) > 2 ) {
					rerenderScore( player );
				}
			}, 300 );
		} );

		enableControls( container, false );
	}

	function enableControls( container, enabled ) {
		var controls = container.querySelectorAll( '.cnr-player__toolbar button, .cnr-player__toolbar input, .cnr-player__toolbar select' );
		Array.prototype.forEach.call( controls, function ( el ) {
			// Pobranie nut i zwijanie/rozwijanie panelu sterowania nie zależą od tego, czy plik
			// się jeszcze wczytuje — mają działać zawsze, tak samo jak przycisk pobierania.
			if ( el.classList.contains( 'cnr-player__download' ) || el.classList.contains( 'cnr-player__collapse-toggle' ) ) {
				return;
			}
			el.disabled = ! enabled;
		} );
	}

	/**
	 * Zwijanie/rozwijanie panelu sterowania (.cnr-player__controls-extra: tempo, głośność,
	 * mikser, pasek postępu) — na telefonie ten panel, wraz z paskiem "zablokowanym"
	 * (position: sticky) u góry ekranu, potrafi być wyższy niż cały widoczny ekran, przez co nuty
	 * są całkowicie zasłonięte i nie da się do nich przewinąć (bo sticky trzyma panel przy górze
	 * niezależnie od przewijania strony). Górny rząd (Odtwórz/Zatrzymaj/Zwiń) zostaje zawsze
	 * widoczny i mały, więc odtwarzanie jest zawsze pod ręką nawet w stanie zwiniętym.
	 *
	 * Na wąskim ekranie (telefon) panel startuje domyślnie ZWINIĘTY, żeby nuty były widoczne od
	 * razu po wejściu na stronę, bez konieczności najpierw szukania przycisku zwijania — na
	 * szerszym ekranie (gdzie sterowanie i tak mieści się obok nut bez przesłaniania ich) startuje
	 * rozwinięty, tak jak dotychczas.
	 */
	function setupCollapseToggle( controlsEl, toggleBtn, iconEl, labelEl ) {
		if ( ! controlsEl || ! toggleBtn ) {
			return;
		}

		function applyState( collapsed ) {
			controlsEl.classList.toggle( 'cnr-player__controls--collapsed', collapsed );
			toggleBtn.setAttribute( 'aria-expanded', collapsed ? 'false' : 'true' );
			if ( iconEl ) {
				iconEl.textContent = collapsed ? '▸' : '▾';
			}
			if ( labelEl ) {
				labelEl.textContent = collapsed ? 'Rozwiń sterowanie' : 'Zwiń sterowanie';
			}
		}

		toggleBtn.addEventListener( 'click', function () {
			applyState( ! controlsEl.classList.contains( 'cnr-player__controls--collapsed' ) );
		} );

		var isNarrowScreen = !! ( window.matchMedia && window.matchMedia( '(max-width: 600px)' ).matches );
		if ( isNarrowScreen ) {
			applyState( true );
		}
	}

	function setStatus( statusEl, message, isError ) {
		if ( ! statusEl ) {
			return;
		}
		statusEl.textContent = message || '';
		statusEl.classList.toggle( 'cnr-player__status--error', !! isError );
		statusEl.style.display = message ? 'block' : 'none';
	}

	/* -----------------------------------------------------------------
	 * Pobranie surowego tekstu MusicXML (własny, niezależny od OSMD odczyt)
	 * --------------------------------------------------------------- */

	function fetchRawMusicXmlText( url, format ) {
		return fetch( url, { credentials: 'same-origin' } ).then( function ( response ) {
			if ( ! response.ok ) {
				throw new Error( 'HTTP ' + response.status );
			}
			if ( 'mxl' === format ) {
				if ( typeof JSZip === 'undefined' ) {
					throw new Error( 'Brak biblioteki JSZip do rozpakowania pliku .mxl.' );
				}
				return response.arrayBuffer().then( function ( buffer ) {
					return JSZip.loadAsync( buffer ).then( extractRootXmlFromZip );
				} );
			}
			return response.text();
		} );
	}

	function extractRootXmlFromZip( zip ) {
		var containerFile = zip.file( 'META-INF/container.xml' );
		if ( containerFile ) {
			return containerFile.async( 'string' ).then( function ( xmlStr ) {
				var doc = new DOMParser().parseFromString( xmlStr, 'application/xml' );
				var rootfile = doc.querySelector( 'rootfile' );
				var path = rootfile ? rootfile.getAttribute( 'full-path' ) : null;
				if ( path && zip.file( path ) ) {
					return zip.file( path ).async( 'string' );
				}
				return fallbackXmlFromZip( zip );
			} );
		}
		return fallbackXmlFromZip( zip );
	}

	function fallbackXmlFromZip( zip ) {
		var foundPath = null;
		zip.forEach( function ( relPath ) {
			if ( ! foundPath && /\.xml$/i.test( relPath ) && 'META-INF/container.xml' !== relPath ) {
				foundPath = relPath;
			}
		} );
		if ( ! foundPath ) {
			return Promise.reject( new Error( 'Nie znaleziono pliku MusicXML wewnątrz archiwum .mxl.' ) );
		}
		return zip.file( foundPath ).async( 'string' );
	}

	/* -----------------------------------------------------------------
	 * Parsowanie MusicXML na harmonogram nut do odtworzenia (własna implementacja
	 * zgodna ze specyfikacją MusicXML — niezależna od wewnętrznego modelu OSMD).
	 * --------------------------------------------------------------- */

	function parseMusicXmlForPlayback( xmlText ) {
		var doc = new DOMParser().parseFromString( xmlText, 'application/xml' );
		if ( doc.querySelector( 'parsererror' ) ) {
			throw new Error( 'Nieprawidłowy plik MusicXML.' );
		}

		var partNames = {};
		Array.prototype.forEach.call( doc.querySelectorAll( 'part-list > score-part' ), function ( sp ) {
			var id      = sp.getAttribute( 'id' );
			var nameEl  = sp.querySelector( 'part-name' );
			var name    = nameEl && nameEl.textContent.trim() ? nameEl.textContent.trim() : id;
			partNames[ id ] = name;
		} );

		// Wykrywanie tempa bazowego (w ćwierćnutach na minutę): najpierw playbackowe <sound
		// tempo="x">, a jeśli go brak (albo ma niepoprawną wartość) — zapasowo z wizualnego
		// oznaczenia metronomu <metronome> (<beat-unit>/<per-minute>, z uwzględnieniem
		// ewentualnych kropek przy wartości rytmicznej). To drugie bywa jedynym, co niektóre
		// programy do zapisu nut (np. starsze wersje niektórych edytorów) w ogóle eksportują —
		// dodają czytelne oznaczenie tempa na partyturze, ale nie dopisują osobnego,
		// "ukrytego" atrybutu playbackowego, więc sama obecność `<sound tempo>` nie
		// wystarczy jako jedyne źródło. Jeśli żadne z nich się nie znajdzie, używamy 120 i
		// informujemy o tym w interfejsie (patrz schedule.bpmDetected/setupPlayer).
		var bpm = 120;
		var bpmDetected = false;

		var tempoEl = doc.querySelector( 'sound[tempo]' );
		if ( tempoEl ) {
			var t = parseFloat( tempoEl.getAttribute( 'tempo' ) );
			if ( ! isNaN( t ) && t > 0 ) {
				bpm = t;
				bpmDetected = true;
			}
		}

		if ( ! bpmDetected ) {
			var metronomeEl = doc.querySelector( 'metronome' );
			if ( metronomeEl ) {
				var perMinuteEl = metronomeEl.querySelector( 'per-minute' );
				var perMinute = perMinuteEl ? parseFloat( perMinuteEl.textContent ) : NaN;
				if ( ! isNaN( perMinute ) && perMinute > 0 ) {
					var beatUnitEl = metronomeEl.querySelector( 'beat-unit' );
					var beatUnit = beatUnitEl ? beatUnitEl.textContent.trim() : 'quarter';
					var dotCount = metronomeEl.querySelectorAll( 'beat-unit-dot' ).length;
					var unitInQuarters = BEAT_UNIT_QUARTERS[ beatUnit ] || 1;
					// Każda kropka wydłuża wartość rytmiczną o połowę poprzedniego dodatku
					// (kropka: x1.5, podwójna kropka: x1.75, ...) — suma szeregu geometrycznego.
					var dotMultiplier = 2 - Math.pow( 0.5, dotCount );
					bpm = perMinute * unitInQuarters * dotMultiplier;
					bpmDetected = true;
				}
			}
		}

		/* -----------------------------------------------------------------
		 * Powtórzenia (znaki repetycji), wolty (1./2. zakończenie) i skoki (D.C./D.S./Fine/
		 * Coda): zanim zbudujemy harmonogram dźwięku, trzeba ustalić FAKTYCZNĄ kolejność
		 * wykonania taktów — inną niż kolejność zapisu w pliku, ilekroć w utworze są
		 * powtórzenia — patrz expandMeasureOrder(). Znaczniki (barline/direction) zbieramy
		 * z KAŻDEGO głosu i łączymy (combineMeasureMarkers): niektóre programy do zapisu nut
		 * wstawiają je tylko w jednym głosie (np. tylko w pierwszym), więc poleganie na jednym
		 * głosie mogłoby przeoczyć część znaczników.
		 * --------------------------------------------------------------- */
		var perPartMeasureEls  = [];
		var perPartMarkers     = [];
		var maxMeasureCount    = 0;

		Array.prototype.forEach.call( doc.querySelectorAll( 'part' ), function ( partEl, partIndex ) {
			var measureEls = Array.prototype.filter.call( partEl.children, function ( c ) {
				return 'measure' === c.tagName;
			} );
			perPartMeasureEls.push( measureEls );
			perPartMarkers.push( measureEls.map( parseMeasureMarkers ) );
			maxMeasureCount = Math.max( maxMeasureCount, measureEls.length );
		} );

		var combinedMarkers   = combineMeasureMarkers( perPartMarkers, maxMeasureCount );
		var measureOrder      = expandMeasureOrder( combinedMarkers );

		/* -----------------------------------------------------------------
		 * Wspólna siatka taktów (od 1.14.1). Każdy takt zaczyna się dla WSZYSTKICH głosów
		 * w tym samym miejscu, a jego długość to najdalsza pozycja osiągnięta w nim przez
		 * którykolwiek głos (tak samo liczy ją OSMD, po którym porusza się kursor). Wcześniej
		 * każdy głos liczył czas osobno, „do ostatniej nuty w takcie” — jeśli drugi głos w takcie
		 * był niepełny (np. tylko półnuta po <backup>, bez pauz), kolejne takty tej partii
		 * startowały za wcześnie: partie zaczynały na siebie nachodzić, a dźwięk coraz bardziej
		 * rozjeżdżał się z podświetleniem w nutach.
		 * --------------------------------------------------------------- */
		var grid = computeMeasureGrid( perPartMeasureEls, maxMeasureCount );
		var measureLens = grid.lengths;
		// Pozycja (w ćwierćnutach) początku KAŻDEGO taktu w kolejności "papierowej" (bez
		// rozwinięcia powtórzeń) — do zsynchronizowania kursora na partyturze (patrz
		// mapPerformedToRaw/mapRawToPerformed niżej), bo kursor OSMD porusza się po
		// wydrukowanych taktach, a nie po faktycznej kolejności wykonania utworu.
		var rawMeasureQuarters = [ 0 ];
		measureLens.forEach( function ( len, i ) {
			rawMeasureQuarters.push( rawMeasureQuarters[ i ] + len );
		} );

		// Mapowanie wykonanie<->zapis dla kursora i początek każdego taktu w wykonaniu.
		var quartersMap = [];
		var performedStarts = [];
		var performedPos = 0;
		// Metronom (od 1.15.0): uderzenia na każdą miarę taktu w kolejności wykonania, pierwsze
		// w takcie akcentowane. Przedtakt (krótszy pierwszy takt) liczymy od końca — np. w 4/4
		// z przedtaktem ćwierćnutowym metronom zaczyna od „4”.
		var clicks = [];
		var meterSpans = [];
		measureOrder.forEach( function ( measureIdx ) {
			quartersMap.push( { performedStart: performedPos, rawStart: rawMeasureQuarters[ measureIdx ] } );
			performedStarts.push( performedPos );
			var len = measureLens[ measureIdx ] || 0;
			var nominalLen = grid.nominal[ measureIdx ] || len;
			var unit = grid.beatUnits[ measureIdx ] || 1;
			var offset = ( 0 === measureIdx && len < nominalLen - 1e-6 ) ? nominalLen - len : 0;
			for ( var b = Math.ceil( offset / unit - 1e-6 ) * unit - offset; b < len - 1e-6; b += unit ) {
				clicks.push( { start: performedPos + b, accent: Math.abs( b + offset ) < 1e-6 } );
			}
			meterSpans.push( { start: performedPos, len: len, nominal: nominalLen, unit: unit, offset: offset } );
			performedPos += len;
		} );

		var voiceNotes   = {};
		var voiceOrder   = [];
		var lastStartByKey = {};
		// Nuty połączone ligaturą (<tie type="start"/> / <tie type="stop"/> — wiążące dźwięk,
		// w odróżnieniu od <notations><tied>, które jest tylko oznaczeniem wizualnym) mają być
		// odtworzone jako JEDEN przedłużony dźwięk, a nie dwa osobne uderzenia. Klucz to
		// "głos#wysokość dźwięku", bo w akordzie różne wysokości mogą mieć niezależne ligatury.
		var pendingTies = {};

		Array.prototype.forEach.call( doc.querySelectorAll( 'part' ), function ( partEl, partIndex ) {
			var partId     = partEl.getAttribute( 'id' );
			var measureEls = perPartMeasureEls[ partIndex ];

			measureOrder.forEach( function ( measureIdx, orderIdx ) {
				var measureEl = measureEls[ measureIdx ];
				if ( ! measureEl ) {
					// Ten głos nie ma tylu taktów co pozostałe (niepoprawnie zapisany plik) —
					// pomijamy, reszta odtwarzacza i tak działa dla pozostałych głosów.
					return;
				}
				// Pozycje liczone w ćwierćnutach od wspólnego początku taktu.
				var divisions = grid.divisions[ partIndex ][ measureIdx ] || 1;
				var pos = performedStarts[ orderIdx ];

				Array.prototype.forEach.call( measureEl.children, function ( node ) {
					var tag = node.tagName;

					if ( 'attributes' === tag ) {
						var divEl = node.querySelector( 'divisions' );
						if ( divEl ) {
							var d = parseInt( divEl.textContent, 10 );
							if ( d > 0 ) {
								divisions = d;
							}
						}
						return;
					}

					if ( 'backup' === tag || 'forward' === tag ) {
						var shiftEl = node.querySelector( 'duration' );
						var shift = shiftEl ? ( parseInt( shiftEl.textContent, 10 ) || 0 ) / divisions : 0;
						pos += 'backup' === tag ? -shift : shift;
						return;
					}

					if ( 'note' !== tag ) {
						return;
					}

					var isChord = !! queryDirectChild( node, 'chord' );
					var isRest  = !! queryDirectChild( node, 'rest' );
					var isGrace = !! queryDirectChild( node, 'grace' );
					// Nuty niesłyszalne: małe nuty-podpowiedzi z innej partii (<cue/>) oraz nuty
					// ukryte w zapisie (print-object="no") — zajmują czas, ale ich nie gramy.
					var isSilent = !! queryDirectChild( node, 'cue' ) || 'no' === node.getAttribute( 'print-object' );
					var durEl   = queryDirectChild( node, 'duration' );
					var dur     = durEl ? ( parseInt( durEl.textContent, 10 ) || 0 ) : 0;
					var voiceEl = queryDirectChild( node, 'voice' );
					var voiceNum = voiceEl ? voiceEl.textContent.trim() : '1';
					var key = partId + '-' + voiceNum;

					var thisStart = pos;
					if ( isChord && Object.prototype.hasOwnProperty.call( lastStartByKey, key ) ) {
						thisStart = lastStartByKey[ key ];
					}

					if ( ! isGrace && ! isRest && ! isSilent && dur > 0 ) {
						var pitchEl = queryDirectChild( node, 'pitch' );
						if ( pitchEl ) {
							var stepEl = pitchEl.querySelector( 'step' );
							var octEl  = pitchEl.querySelector( 'octave' );
							var alterEl = pitchEl.querySelector( 'alter' );
							var step   = stepEl ? stepEl.textContent.trim() : '';
							var octave = octEl ? parseInt( octEl.textContent, 10 ) : NaN;
							var alter  = alterEl ? ( Math.round( parseFloat( alterEl.textContent ) ) || 0 ) : 0;
							var base   = NOTE_BASE[ step ];

							if ( undefined !== base && ! isNaN( octave ) ) {
								var midi = base + alter + ( octave + 1 ) * 12;

								var tieEls = queryDirectChildren( node, 'tie' );
								var tieStart = tieEls.some( function ( te ) {
									return 'start' === te.getAttribute( 'type' );
								} );
								var tieStop = tieEls.some( function ( te ) {
									return 'stop' === te.getAttribute( 'type' );
								} );

								var pendingKey = key + '#' + midi;
								var thisDur    = dur / divisions;
								var merged     = false;

								if ( tieStop && Object.prototype.hasOwnProperty.call( pendingTies, pendingKey ) ) {
									var prevNote = pendingTies[ pendingKey ];
									var expectedStart = prevNote.start + prevNote.dur;
									// Sprawdzamy, że ta nuta rzeczywiście zaczyna się dokładnie tam, gdzie
									// kończy się poprzednia (z małym marginesem na błędy zaokrąglenia) —
									// zabezpieczenie przed błędnie/niekompletnie zapisaną ligaturą w pliku.
									if ( Math.abs( thisStart - expectedStart ) < 0.0001 ) {
										prevNote.dur += thisDur;
										merged = true;
										if ( tieStart ) {
											pendingTies[ pendingKey ] = prevNote;
										} else {
											delete pendingTies[ pendingKey ];
										}
									}
								}

								if ( ! merged ) {
									if ( ! voiceNotes[ key ] ) {
										voiceNotes[ key ] = [];
										voiceOrder.push( { partId: partId, voiceNum: voiceNum, key: key } );
									}
									var newNote = { start: thisStart, dur: thisDur, midi: midi };
									voiceNotes[ key ].push( newNote );
									if ( tieStart ) {
										pendingTies[ pendingKey ] = newNote;
									} else {
										delete pendingTies[ pendingKey ];
									}
								}
							}
						}
					}

					lastStartByKey[ key ] = thisStart;

					if ( ! isChord && ! isGrace ) {
						var adv = dur / divisions;
						if ( isRest && isMeasureRest( node ) && grid.nominal[ measureIdx ] ) {
							adv = Math.min( adv, grid.nominal[ measureIdx ] );
						}
						pos += adv;
					}
				} );
			} );
		} );

		// Utwory zapisane akordowo (jeden głos MusicXML, w którym wielodźwięki niosą kilka
		// realnych głosów chóralnych naraz, bez osobnej linii na głos) rozpoznajemy "najlepszym
		// możliwym staraniem" i rozdzielamy na osobne pseudo-głosy do niezależnego miksowania —
		// patrz splitChordVoices().
		var chordSplit = splitChordVoices( voiceNotes, voiceOrder );
		voiceNotes = chordSplit.voiceNotes;
		voiceOrder = chordSplit.voiceOrder;

		var partVoiceCounts = {};
		voiceOrder.forEach( function ( v ) {
			partVoiceCounts[ v.partId ] = ( partVoiceCounts[ v.partId ] || 0 ) + 1;
		} );

		var partVoiceSeen = {};
		var voices = voiceOrder.map( function ( v ) {
			var baseLabel = partNames[ v.partId ] || v.partId;
			var label = baseLabel;
			if ( v.chordSplitLabel ) {
				label = baseLabel + ' – ' + v.chordSplitLabel;
			} else if ( partVoiceCounts[ v.partId ] > 1 ) {
				partVoiceSeen[ v.partId ] = ( partVoiceSeen[ v.partId ] || 0 ) + 1;
				label = baseLabel + ' – głos ' + partVoiceSeen[ v.partId ];
			}
			var notes = voiceNotes[ v.key ].slice().sort( function ( a, b ) {
				return a.start - b.start;
			} );
			return { key: v.key, label: label, notes: notes };
		} );

		var totalQuarters = performedPos;
		voices.forEach( function ( v ) {
			v.notes.forEach( function ( n ) {
				totalQuarters = Math.max( totalQuarters, n.start + n.dur );
			} );
		} );

		return { bpm: bpm, bpmDetected: bpmDetected, voices: voices, totalQuarters: totalQuarters, quartersMap: quartersMap, clicks: clicks, meterSpans: meterSpans };
	}

	function isMeasureRest( noteEl ) {
		var restEl = queryDirectChild( noteEl, 'rest' );
		return !! restEl && 'yes' === restEl.getAttribute( 'measure' );
	}

	function queryDirectChild( parent, tagName ) {
		for ( var i = 0; i < parent.children.length; i++ ) {
			if ( parent.children[ i ].tagName === tagName ) {
				return parent.children[ i ];
			}
		}
		return null;
	}

	/** Jak queryDirectChild, ale zwraca WSZYSTKIE pasujące bezpośrednie dzieci (np. <tie> — nuta może mieć jednocześnie tie type="stop" i tie type="start"). */
	function queryDirectChildren( parent, tagName ) {
		var out = [];
		for ( var i = 0; i < parent.children.length; i++ ) {
			if ( parent.children[ i ].tagName === tagName ) {
				out.push( parent.children[ i ] );
			}
		}
		return out;
	}

	/* -----------------------------------------------------------------
	 * Powtórzenia, wolty (1./2. zakończenie) i skoki (D.C./D.S./Fine/Segno/Coda) — ustalenie
	 * FAKTYCZNEJ kolejności wykonania taktów na podstawie <barline>/<direction><sound> w pliku
	 * MusicXML. Obsługujemy typowe przypadki spotykane w nutach chóralnych: proste powtórzenia
	 * (||: … :||, także z times="N"), 1./2. (i kolejne) zakończenia (wolty) powiązane
	 * z powtórzeniem, oraz D.C./D.S. al Fine / al Coda. Zagnieżdżone powtórzenia (powtórzenie
	 * wewnątrz powtórzenia) nie są w pełni obsługiwane — to rzadkość w repertuarze chóralnym —
	 * ale nie psują odtwarzania prostszych, dużo częstszych przypadków.
	 * --------------------------------------------------------------- */

	/** Wyciąga z JEDNEGO taktu znaczniki powtórzeń/wolt/skoków (z <barline> i <direction><sound>). */
	function parseMeasureMarkers( measureEl ) {
		var markers = {
			startRepeat: false,
			endRepeat: false,
			repeatTimes: null,
			// Wolty (1./2. zakończenie): każdy wpis to { numbers: [1] / [1,2] / …, type: 'start' | 'stop' | 'discontinue' },
			// bo pojedynczy takt może mieć jednocześnie znacznik na lewej I prawej kresce taktowej
			// (jednotaktowa wolta). Rozciągnięcie tych numerów na środkowe takty wielotaktowej
			// wolty dzieje się później, w combineMeasureMarkers — środkowe takty w pliku w ogóle
			// nie mają własnego znacznika <ending>.
			endingMarks: [],
			segno: false,
			coda: false,
			dacapo: false,
			dalsegno: false,
			fine: false,
			tocoda: false
		};

		Array.prototype.forEach.call( measureEl.children, function ( node ) {
			var tag = node.tagName;

			if ( 'barline' === tag ) {
				var repeatEl = node.querySelector( 'repeat' );
				if ( repeatEl ) {
					var dir = repeatEl.getAttribute( 'direction' );
					if ( 'forward' === dir ) {
						markers.startRepeat = true;
					} else if ( 'backward' === dir ) {
						markers.endRepeat = true;
						var timesAttr = parseInt( repeatEl.getAttribute( 'times' ), 10 );
						markers.repeatTimes = ( ! isNaN( timesAttr ) && timesAttr > 0 ) ? timesAttr : 2;
					}
				}
				var endingEl = node.querySelector( 'ending' );
				if ( endingEl ) {
					var numAttr = endingEl.getAttribute( 'number' ) || '';
					// Specyfikacja MusicXML: numery oddzielone przecinkami ("1, 2"), ale część
					// programów zapisuje je spacją ("1 2") albo z kropką ("1.") — akceptujemy wszystkie.
					var nums = numAttr.split( /[\s,]+/ ).map( function ( s ) {
						return parseInt( s.trim(), 10 );
					} ).filter( function ( n ) {
						return ! isNaN( n );
					} );
					if ( nums.length ) {
						markers.endingMarks.push( { numbers: nums, type: endingEl.getAttribute( 'type' ) || 'start' } );
					}
				}
				return;
			}

			if ( 'direction' === tag ) {
				// Kanoniczne, playbackowe znaczniki skoków/Fine/Segno/Coda — <sound> (tak samo jak
				// przy wykrywaniu tempa: to jedyne pole, po którym da się to rozpoznać niezawodnie;
				// samo słowo "D.C. al Fine" wypisane jako <words> jest tylko tekstem na partyturze).
				var soundEl = node.querySelector( 'sound' );
				if ( soundEl ) {
					if ( 'yes' === soundEl.getAttribute( 'dacapo' ) ) {
						markers.dacapo = true;
					}
					if ( soundEl.getAttribute( 'dalsegno' ) ) {
						markers.dalsegno = true;
					}
					if ( 'yes' === soundEl.getAttribute( 'fine' ) ) {
						markers.fine = true;
					}
					if ( soundEl.getAttribute( 'tocoda' ) ) {
						markers.tocoda = true;
					}
					if ( soundEl.getAttribute( 'segno' ) ) {
						markers.segno = true;
					}
					if ( soundEl.getAttribute( 'coda' ) ) {
						markers.coda = true;
					}
				}
			}
		} );

		return markers;
	}

	/**
	 * Łączy znaczniki taktów zebrane z KAŻDEGO głosu (niektóre programy do zapisu nut wstawiają
	 * <barline>/<direction><sound> tylko w jednym głosie, np. pierwszym) w jedną, wspólną listę —
	 * i rozciąga numery wolt na środkowe takty wielotaktowych zakończeń (patrz komentarz w
	 * parseMeasureMarkers).
	 */
	function combineMeasureMarkers( perPartMarkers, measureCount ) {
		var combined = [];
		for ( var i = 0; i < measureCount; i++ ) {
			var merged = {
				startRepeat: false, endRepeat: false, repeatTimes: null,
				endingMarks: [], endingNumbers: null,
				segno: false, coda: false, dacapo: false, dalsegno: false, fine: false, tocoda: false
			};
			perPartMarkers.forEach( function ( arr ) {
				var m = arr[ i ];
				if ( ! m ) {
					return;
				}
				merged.startRepeat = merged.startRepeat || m.startRepeat;
				merged.endRepeat   = merged.endRepeat || m.endRepeat;
				if ( m.repeatTimes ) {
					merged.repeatTimes = m.repeatTimes;
				}
				if ( m.endingMarks && m.endingMarks.length ) {
					merged.endingMarks = merged.endingMarks.concat( m.endingMarks );
				}
				merged.segno    = merged.segno || m.segno;
				merged.coda     = merged.coda || m.coda;
				merged.dacapo   = merged.dacapo || m.dacapo;
				merged.dalsegno = merged.dalsegno || m.dalsegno;
				merged.fine     = merged.fine || m.fine;
				merged.tocoda   = merged.tocoda || m.tocoda;
			} );
			combined.push( merged );
		}

		var activeEndingNumbers = null;
		combined.forEach( function ( m ) {
			m.endingMarks.forEach( function ( em ) {
				if ( 'start' === em.type ) {
					activeEndingNumbers = em.numbers;
				}
			} );
			if ( activeEndingNumbers ) {
				m.endingNumbers = activeEndingNumbers;
			}
			m.endingMarks.forEach( function ( em ) {
				if ( 'stop' === em.type || 'discontinue' === em.type ) {
					activeEndingNumbers = null;
				}
			} );
		} );

		return combined;
	}

	/**
	 * Symuluje odtwarzanie partytury takt po takcie zgodnie ze znacznikami powtórzeń/wolt/
	 * skoków i zwraca faktyczną kolejność wykonania (tablicę indeksów taktów — z powtórzeniami,
	 * jeśli w utworze są). Bez żadnych znaczników zwraca zwykłą kolejność 0..N-1.
	 *
	 * Od 1.13.0 każda kreska powtórzenia ":||" ma ustalony z góry POCZĄTEK swojej części:
	 * najbliższą wcześniejszą kreskę "||:", a gdy jej nie ma — takt po poprzedniej zakończonej
	 * części (po ostatniej wolcie poprzedniej grupy) albo początek utworu. Licznik przejść jest
	 * osobny dla każdej części. Wcześniej był jeden wspólny licznik i jeden początek — druga
	 * część z woltami bez "||:" (częste w nutach chóralnych) grała bez powtórzenia i bez
	 * żadnej z wolt.
	 *
	 * Po skoku D.C./D.S. powtórzenia nie są już wykonywane, a z każdej grupy wolt gra
	 * OSTATNIA (np. "2.") — zgodnie z typową praktyką wykonawczą.
	 */
	function expandMeasureOrder( markers ) {
		var order = [];
		var total = markers.length;
		if ( ! total ) {
			return order;
		}

		// --- Struktura: początek części dla każdej kreski ":||" i każdego taktu ---
		var sectionOf = [];   // indeks początku części, do której należy takt
		var repeatTarget = []; // dla taktu z ":||" — dokąd wraca
		var sectionStart = 0;
		var pendingAfterVoltas = false; // ":||" w wolcie: nowa część zaczyna się po grupie wolt
		markers.forEach( function ( m, j ) {
			var inVolta = !! m.endingNumbers;
			if ( pendingAfterVoltas && ! inVolta ) {
				sectionStart = j;
				pendingAfterVoltas = false;
			}
			if ( m.startRepeat ) {
				sectionStart = j;
				pendingAfterVoltas = false;
			}
			sectionOf[ j ] = sectionStart;
			if ( m.endRepeat ) {
				repeatTarget[ j ] = sectionStart;
				if ( inVolta ) {
					pendingAfterVoltas = true;
				} else {
					sectionStart = j + 1;
				}
			}
		} );

		// Najwyższy numer wolty w każdej grupie wolt (kolejne takty z endingNumbers) — gra po D.C./D.S.
		var groupMax = [];
		var g = 0;
		while ( g < total ) {
			if ( ! markers[ g ].endingNumbers ) {
				g++;
				continue;
			}
			var gEnd = g;
			var maxNum = 0;
			while ( gEnd < total && markers[ gEnd ].endingNumbers && sectionOf[ gEnd ] === sectionOf[ g ] ) {
				maxNum = Math.max.apply( null, [ maxNum ].concat( markers[ gEnd ].endingNumbers ) );
				gEnd++;
			}
			for ( var k = g; k < gEnd; k++ ) {
				groupMax[ k ] = maxNum;
			}
			g = gEnd;
		}

		var segnoIndex = -1;
		var codaIndex  = -1;
		markers.forEach( function ( m, idx ) {
			if ( m.segno && -1 === segnoIndex ) {
				segnoIndex = idx;
			}
			if ( m.coda && -1 === codaIndex ) {
				codaIndex = idx;
			}
		} );

		// --- Symulacja wykonania ---
		var passCounts = {}; // początek części -> numer bieżącego przejścia (1, 2, …)
		var jumped = false;
		var i = 0;
		var guard = 0;
		// Zabezpieczenie przed nieskończoną pętlą przy błędnie/niekompletnie zapisanym pliku.
		var maxSteps = total * 12 + 100;

		while ( i < total && guard++ < maxSteps ) {
			var m = markers[ i ];

			if ( m.endingNumbers ) {
				var play = jumped
					? -1 !== m.endingNumbers.indexOf( groupMax[ i ] )
					: -1 !== m.endingNumbers.indexOf( passCounts[ sectionOf[ i ] ] || 1 );
				if ( ! play ) {
					i++;
					continue;
				}
			}

			order.push( i );

			if ( m.fine && jumped ) {
				break;
			}

			if ( m.tocoda && jumped && codaIndex >= 0 ) {
				i = codaIndex;
				continue;
			}

			if ( m.endRepeat && ! jumped ) {
				var target = repeatTarget[ i ];
				var times = m.repeatTimes || 2;
				var pass = passCounts[ target ] || 1;
				if ( pass < times ) {
					passCounts[ target ] = pass + 1;
					i = target;
					continue;
				}
			}

			if ( m.dacapo && ! jumped ) {
				jumped = true;
				i = 0;
				continue;
			}

			if ( m.dalsegno && ! jumped ) {
				jumped = true;
				i = segnoIndex >= 0 ? segnoIndex : ( i + 1 );
				continue;
			}

			i++;
		}

		if ( guard >= maxSteps ) {
			// Nietypowa/błędna struktura powtórzeń — zamiast ryzykować ucięte albo zapętlone
			// odtwarzanie, wracamy do prostej kolejności bez powtórzeń.
			return markers.map( function ( mm, idx ) {
				return idx;
			} );
		}

		return order;
	}

	/**
	 * Pozycja (w ćwierćnutach) początku KAŻDEGO taktu w NATURALNEJ kolejności zapisu w pliku
	 * (bez rozwijania powtórzeń) — licząc jak w głównej pętli parsującej (divisions/duration/
	 * backup/forward), ale bez wysokości dźwięku (potrzebujemy tylko granic taktów). Używane
	 * wyłącznie do zsynchronizowania kursora na partyturze (patrz mapPerformedToRaw/
	 * mapRawToPerformed) — kursor OSMD porusza się po taktach w kolejności "papierowej", a nie
	 * w kolejności faktycznego wykonania utworu.
	 */
	/**
	 * Długość każdego taktu (w ćwierćnutach) wspólna dla wszystkich partii: najdalsza pozycja
	 * osiągnięta w takcie przez którykolwiek głos (nuta, pauza albo <forward>). Pusty takt
	 * dostaje długość z oznaczenia metrum. Zwraca też liczbę <divisions> obowiązującą na
	 * początku każdego taktu każdej partii — potrzebną, gdy wykonanie (powtórzenia) skacze
	 * między taktami.
	 */
	function computeMeasureGrid( perPartMeasureEls, measureCount ) {
		var lengths = [];
		var divisionsAtStart = [];
		for ( var i = 0; i < measureCount; i++ ) {
			lengths.push( 0 );
		}
		var nominal = [];
		var beatUnits = [];

		perPartMeasureEls.forEach( function ( measureEls, partIndex ) {
			var divisions = 1;
			var timeQuarters = 4;
			var beatQuarters = 1;
			divisionsAtStart[ partIndex ] = [];

			measureEls.forEach( function ( measureEl, measureIdx ) {
				divisionsAtStart[ partIndex ][ measureIdx ] = divisions;
				var pos = 0;
				var maxPos = 0;

				Array.prototype.forEach.call( measureEl.children, function ( node ) {
					var tag = node.tagName;
					if ( 'attributes' === tag ) {
						var divEl = node.querySelector( 'divisions' );
						if ( divEl ) {
							var d = parseInt( divEl.textContent, 10 );
							if ( d > 0 ) {
								// Zmiana divisions na początku taktu dotyczy całego taktu.
								if ( 0 === pos && 0 === maxPos ) {
									divisionsAtStart[ partIndex ][ measureIdx ] = d;
								}
								divisions = d;
							}
						}
						var beatsEl = node.querySelector( 'time > beats' );
						var typeEl  = node.querySelector( 'time > beat-type' );
						if ( beatsEl && typeEl ) {
							var beats = String( beatsEl.textContent ).split( '+' ).reduce( function ( sum, x ) {
								return sum + ( parseFloat( x ) || 0 );
							}, 0 );
							var beatType = parseFloat( typeEl.textContent );
							if ( beats > 0 && beatType > 0 ) {
								timeQuarters = beats * 4 / beatType;
								// Metrum złożone (6/8, 9/8, 12/8…) liczymy „na ćwierćnuty z kropką”.
								beatQuarters = ( beatType >= 8 && beats > 3 && 0 === beats % 3 ) ? 3 * 4 / beatType : 4 / beatType;
							}
						}
						return;
					}
					var durEl, dur;
					if ( 'backup' === tag || 'forward' === tag ) {
						durEl = node.querySelector( 'duration' );
						dur = durEl ? ( parseInt( durEl.textContent, 10 ) || 0 ) / divisions : 0;
						pos = 'backup' === tag ? Math.max( 0, pos - dur ) : pos + dur;
						maxPos = Math.max( maxPos, pos );
						return;
					}
					if ( 'note' !== tag ) {
						return;
					}
					if ( queryDirectChild( node, 'chord' ) || queryDirectChild( node, 'grace' ) ) {
						return;
					}
					durEl = queryDirectChild( node, 'duration' );
					dur = durEl ? ( parseInt( durEl.textContent, 10 ) || 0 ) / divisions : 0;
					if ( isMeasureRest( node ) ) {
						// Pauza całotaktowa trwa cały takt wg metrum — niektóre programy zapisują
						// ją jako całą nutę także w 3/4 (tak ją też liczy kursor OSMD).
						dur = Math.min( dur, timeQuarters );
					}
					pos += dur;
					maxPos = Math.max( maxPos, pos );
				} );

				lengths[ measureIdx ] = Math.max( lengths[ measureIdx ] || 0, maxPos );
				if ( undefined === nominal[ measureIdx ] ) {
					nominal[ measureIdx ] = timeQuarters;
					beatUnits[ measureIdx ] = beatQuarters;
				}
			} );
		} );

		for ( var m = 0; m < measureCount; m++ ) {
			if ( ! ( lengths[ m ] > 0 ) ) {
				lengths[ m ] = nominal[ m ] || 4;
			}
		}
		return { lengths: lengths, divisions: divisionsAtStart, nominal: nominal, beatUnits: beatUnits };
	}

	/** Znajduje indeks ostatniego kroku kursora (cursorSteps), którego pozycja <= podana wartość. */
	function findRawStepIndex( cursorSteps, rawQuarters ) {
		var idx = 0;
		for ( var i = 0; i < cursorSteps.length; i++ ) {
			if ( cursorSteps[ i ] <= rawQuarters ) {
				idx = i;
			} else {
				break;
			}
		}
		return idx;
	}

	/** Przelicza pozycję w WYKONANIU utworu (uwzględniającą powtórzenia) na pozycję "papierową" w zapisie — do poruszania kursorem na partyturze. */
	function mapPerformedToRaw( quartersMap, performedQuarters ) {
		if ( ! quartersMap || ! quartersMap.length ) {
			return performedQuarters;
		}
		var lo = 0;
		var hi = quartersMap.length - 1;
		while ( lo < hi ) {
			var mid = ( lo + hi + 1 ) >> 1;
			if ( quartersMap[ mid ].performedStart <= performedQuarters ) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		var seg = quartersMap[ lo ];
		return seg.rawStart + Math.max( 0, performedQuarters - seg.performedStart );
	}

	/**
	 * Przelicza pozycję "papierową" w zapisie (np. z kliknięcia w nutę na partyturze) na pozycję
	 * w WYKONANIU utworu — odwrotność mapPerformedToRaw. Jeśli dane miejsce w partyturze gra się
	 * więcej niż raz (jest w powtarzanym fragmencie), celuje w PIERWSZE wykonanie — nie da się
	 * jednoznacznie rozstrzygnąć z samego kliknięcia, o które przejście chodzi użytkownikowi,
	 * a pierwsze jest najbardziej intuicyjnym domyślnym wyborem.
	 */
	function mapRawToPerformed( quartersMap, rawQuarters ) {
		if ( ! quartersMap || ! quartersMap.length ) {
			return rawQuarters;
		}
		for ( var i = 0; i < quartersMap.length; i++ ) {
			var seg = quartersMap[ i ];
			var segRawEnd = ( i + 1 < quartersMap.length )
				? seg.rawStart + ( quartersMap[ i + 1 ].performedStart - seg.performedStart )
				: Infinity;
			if ( rawQuarters >= seg.rawStart && rawQuarters < segRawEnd ) {
				return seg.performedStart + ( rawQuarters - seg.rawStart );
			}
		}
		return rawQuarters;
	}

	/* -----------------------------------------------------------------
	 * Rozpoznawanie głosów z zapisu akordowego (jeden głos MusicXML zawierający
	 * wielodźwięki zamiast osobnej linii na każdy głos chóralny) — heurystyka
	 * "najlepszym możliwym staraniem", nie analiza muzykologiczna prowadzenia głosów.
	 * --------------------------------------------------------------- */

	/** Grupuje nuty jednego głosu wg momentu startu (wszystkie dźwięki jednego wielodźwięku razem), zachowując kolejność występowania. */
	function groupNotesByStart( notes ) {
		var byStart = {};
		var order = [];
		notes.forEach( function ( n ) {
			var k = n.start.toFixed( 6 );
			if ( ! byStart[ k ] ) {
				byStart[ k ] = [];
				order.push( k );
			}
			byStart[ k ].push( n );
		} );
		return order.map( function ( k ) {
			return byStart[ k ];
		} );
	}

	function chordVoiceLabels( count ) {
		if ( 4 === count ) {
			return [ 'Sopran (akord)', 'Alt (akord)', 'Tenor (akord)', 'Bas (akord)' ];
		}
		if ( 3 === count ) {
			return [ 'Góra (akord)', 'Środek (akord)', 'Dół (akord)' ];
		}
		if ( 2 === count ) {
			return [ 'Góra (akord)', 'Dół (akord)' ];
		}
		var labels = [];
		for ( var i = 0; i < count; i++ ) {
			labels.push( 'Głos ' + ( i + 1 ) + ' (akord)' );
		}
		return labels;
	}

	/**
	 * Dla każdego głosu MusicXML sprawdza, czy wygląda na zapis akordowy (znacząca część
	 * wielodźwięków, konsekwentna liczba dźwięków naraz, wystarczająco dużo nut, żeby to nie
	 * był przypadkowy pojedynczy akord/divisi) — jeśli tak, rozdziela go na tyle pseudo-głosów,
	 * ile dźwięków ma typowy wielodźwięk, przypisując każdej nucie "rangę" wg wysokości
	 * (najwyższy dźwięk = głos najwyższy, najniższy = najniższy). To jedyny sposób, w jaki
	 * możemy w ogóle spróbować rozpoznać głosy bez osobnych linii <voice> w pliku — nie
	 * gwarantuje poprawnego prowadzenia głosów (np. skrzyżowań głosów), tylko najlepsze możliwe
	 * przybliżenie.
	 */
	function splitChordVoices( voiceNotes, voiceOrder ) {
		var newVoiceOrder = [];
		var newVoiceNotes = {};

		voiceOrder.forEach( function ( v ) {
			var notes = voiceNotes[ v.key ];
			var groups = groupNotesByStart( notes );
			var chordGroups = groups.filter( function ( g ) {
				return g.length >= 2;
			} );
			var chordCount = chordGroups.length;
			var totalGroups = groups.length;
			var maxChordSize = groups.reduce( function ( m, g ) {
				return Math.max( m, g.length );
			}, 1 );

			// Progi: co najmniej 6 momentów w czasie (żeby nie "rozdzielać" pojedynczego
			// przypadkowego akordu/divisi), ponad 30% z nich to wielodźwięki, a typowy
			// wielodźwięk ma 2–6 dźwięków (więcej niż 6 to już raczej akompaniament fortepianu
			// niż głosy chóralne, i nie próbujemy tego dzielić).
			if ( totalGroups >= 6 && chordCount / totalGroups > 0.3 && maxChordSize >= 2 && maxChordSize <= 6 ) {
				var partsCount = maxChordSize;
				var labels = chordVoiceLabels( partsCount );
				for ( var r = 0; r < partsCount; r++ ) {
					var pseudoKey = v.key + '-akord' + r;
					newVoiceNotes[ pseudoKey ] = [];
					newVoiceOrder.push( { partId: v.partId, voiceNum: v.voiceNum, key: pseudoKey, chordSplitLabel: labels[ r ] } );
				}
				groups.forEach( function ( g ) {
					var sorted = g.slice().sort( function ( a, b ) {
						return b.midi - a.midi; // wysoki -> niski
					} );
					for ( var i = 0; i < sorted.length; i++ ) {
						var rank = Math.min( i, partsCount - 1 );
						var pk = v.key + '-akord' + rank;
						newVoiceNotes[ pk ].push( sorted[ i ] );
					}
				} );
			} else {
				newVoiceNotes[ v.key ] = notes;
				newVoiceOrder.push( v );
			}
		} );

		return { voiceNotes: newVoiceNotes, voiceOrder: newVoiceOrder };
	}

	/* -----------------------------------------------------------------
	 * Sterowanie głosami (wycisz / solo)
	 * --------------------------------------------------------------- */

	function buildFlatNotes( player ) {
		var flat = [];
		player.schedule.voices.forEach( function ( voice ) {
			// Wszystko jest od razu słyszalne (nic nie jest domyślnie wyciszone) — jedyna
			// "domyślność" to dobór brzmienia: głosy rozpoznane jako fortepian/akompaniament
			// dostają domyślnie brzmienie fortepianu, reszta chóralne "Aahs"; można to
			// zmienić dla każdego głosu z osobna w mikserze (patrz buildVoiceControls).
			// Brzmienie startowe: domyślne z ustawień, jeśli wbudowane (SoundFont dochodzi po
			// wczytaniu pliku — patrz applySoundSource), inaczej chór / fortepian.
			var configured = player.defaults ? ( ACCOMPANIMENT_PATTERN.test( voice.label ) ? player.defaults.accomp : player.defaults.voice ) : '';
			var defaultInstrument = isBuiltinTimbre( configured ) ? configured : ( ACCOMPANIMENT_PATTERN.test( voice.label ) ? 'acoustic_grand_piano' : DEFAULT_VOICE_TIMBRE );
			player.voiceStates[ voice.key ] = { muted: false, solo: false, volume: 1, instrument: defaultInstrument };
			voice.notes.forEach( function ( n ) {
				flat.push( { key: voice.key, start: n.start, dur: n.dur, midi: n.midi } );
			} );
		} );
		flat.sort( function ( a, b ) {
			return a.start - b.start;
		} );
		player.flatNotes = flat;
	}

	function buildVoiceControls( voicesEl, player ) {
		if ( ! voicesEl ) {
			return;
		}
		voicesEl.innerHTML = '';

		if ( ! player.schedule.voices.length ) {
			return;
		}

		var heading = document.createElement( 'p' );
		heading.className = 'cnr-player__voices-heading';
		heading.textContent = 'Mikser głosów:';
		voicesEl.appendChild( heading );

		if ( player.soundfonts.length || ! defaultsAreStandard( player ) ) {
			// Jednym wyborem — brzmienia dla wszystkich głosów (od 1.13.0); każdy głos można
			// potem zmienić osobno w jego kanale.
			var sourceLabel = document.createElement( 'label' );
			sourceLabel.className = 'cnr-player__sound-source';
			sourceLabel.appendChild( document.createTextNode( 'Brzmienia: ' ) );
			var sourceSelect = document.createElement( 'select' );
			sourceSelect.className = 'cnr-player__sound-source-select';
			var defaultOpt = document.createElement( 'option' );
			defaultOpt.value = 'default';
			defaultOpt.textContent = 'Domyślne (' + describeDefaults( player ) + ')';
			sourceSelect.appendChild( defaultOpt );
			var builtinOpt = document.createElement( 'option' );
			builtinOpt.value = 'builtin';
			builtinOpt.textContent = 'Wbudowane (Chór / Fortepian)';
			sourceSelect.appendChild( builtinOpt );
			player.soundfonts.forEach( function ( sf ) {
				var o = document.createElement( 'option' );
				o.value = 'sf2:' + sf.id;
				o.textContent = 'SoundFont: ' + sf.name;
				sourceSelect.appendChild( o );
			} );
			sourceSelect.value = player.soundSource;
			sourceSelect.addEventListener( 'change', function () {
				applySoundSource( player, sourceSelect.value );
			} );
			sourceLabel.appendChild( sourceSelect );
			voicesEl.appendChild( sourceLabel );
		}

		player.schedule.voices.forEach( function ( voice ) {
			voicesEl.appendChild( buildChannelStrip( player, player.voiceStates[ voice.key ], voice.label, {
				timbre: true,
				solo: true,
				// Głosy chóralne nie mają własnego węzła Web Audio (ich głośność computeGain czyta
				// na bieżąco), ale Mute/Solo tutaj mogą zmienić, czy podkład instrumentalny
				// powinien być słyszalny (patrz isAnySoloActive) — stąd też odświeżamy jego
				// głośność przy KAŻDEJ zmianie w mikserze głosów, nie tylko podkładu.
				onVolumeChange: function () {
					applyAudioVolume( player );
				}
			} ) );
		} );
	}

	/**
	 * Buduje jeden "kanał" miksera w stylu DAW: etykieta, miejsce na wybór brzmienia (jeśli
	 * kanał go ma), pionowy suwak głośności, wartość procentowa, a na dole przyciski Mute/Solo.
	 * Współdzielone przez głosy chóralne (buildVoiceControls, state = player.voiceStates[key])
	 * i podkład instrumentalny (buildBackingTrackControl, state = player.backingTrack) — ten
	 * drugi bez wyboru brzmienia, ale (tak jak każdy inny kanał) z Mute i Solo.
	 *
	 * Miejsce na wybór brzmienia jest REZERWOWANE (pusty element o stałej wysokości) nawet gdy
	 * options.timbre jest false — inaczej kanał podkładu (bez wyboru brzmienia) byłby niższy niż
	 * kanały głosów, a suwak/przyciski Mute/Solo nie wyrównywałyby się w poziomie między kanałami.
	 */
	function buildChannelStrip( player, state, label, options ) {
		var strip = document.createElement( 'div' );
		strip.className = 'cnr-player__voice-row';

		var labelEl = document.createElement( 'span' );
		labelEl.className = 'cnr-player__voice-label';
		labelEl.textContent = label;
		strip.appendChild( labelEl );

		var timbreWrap = document.createElement( 'div' );
		timbreWrap.className = 'cnr-player__voice-timbre-wrap';
		if ( options.timbre ) {
			var timbreSelect = document.createElement( 'select' );
			timbreSelect.className = 'cnr-player__voice-timbre';
			fillTimbreSelect( player, timbreSelect );
			timbreSelect.value = state.instrument || DEFAULT_VOICE_TIMBRE;
			timbreSelect.addEventListener( 'change', function () {
				var value = timbreSelect.value;
				if ( /^sf2:[^:]+$/.test( value ) ) {
					// SoundFont jeszcze niewczytany — wczytaj go i dobierz brzmienie dla tego głosu.
					var sfId = value.slice( 4 );
					loadBank( player, sfId ).then( function ( bank ) {
						state.instrument = 'sf2:' + sfId + ':' + defaultPresetFor( bank, label );
						rebuildMixer( player );
						loadInstrument( player, state.instrument ).catch( function () {} );
					} ).catch( function () {
						timbreSelect.value = state.instrument || DEFAULT_VOICE_TIMBRE;
					} );
					return;
				}
				state.instrument = value;
				// Wczytaj brzmienie od razu (nie czekając na "Odtwórz"), żeby było gotowe do
				// odtworzenia bez opóźnienia przy najbliższej nucie tego głosu.
				loadInstrument( player, value ).catch( function () {
					// Błąd wczytywania brzmienia — nie powinien przerywać reszty odtwarzacza.
				} );
			} );
			timbreWrap.appendChild( timbreSelect );
		}
		strip.appendChild( timbreWrap );

		var faderWrap = document.createElement( 'div' );
		faderWrap.className = 'cnr-player__voice-fader-wrap';
		var volInput = document.createElement( 'input' );
		volInput.type = 'range';
		volInput.min = '0';
		volInput.max = '150';
		volInput.step = '5';
		var initialPercent = Math.round( ( 'number' === typeof state.volume ? state.volume : 1 ) * 100 );
		volInput.value = String( initialPercent );
		volInput.className = 'cnr-player__voice-volume';
		volInput.setAttribute( 'orient', 'vertical' ); // Firefox honoruje ten atrybut; reszta jedzie na CSS (writing-mode).
		faderWrap.appendChild( volInput );
		strip.appendChild( faderWrap );

		var volValue = document.createElement( 'span' );
		volValue.className = 'cnr-player__voice-volume-value';
		volValue.textContent = initialPercent + '%';
		strip.appendChild( volValue );

		volInput.addEventListener( 'input', function () {
			var percent = parseInt( volInput.value, 10 );
			if ( isNaN( percent ) ) {
				percent = 100;
			}
			volValue.textContent = percent + '%';
			state.volume = percent / 100;
			if ( options.onVolumeChange ) {
				options.onVolumeChange();
			}
		} );

		var bottomRow = document.createElement( 'div' );
		bottomRow.className = 'cnr-player__voice-bottom';

		var muteBtn = document.createElement( 'button' );
		muteBtn.type = 'button';
		muteBtn.className = 'cnr-player__voice-btn cnr-player__voice-btn--mute';
		muteBtn.textContent = 'M';
		muteBtn.title = 'Wycisz';
		muteBtn.setAttribute( 'aria-pressed', state.muted ? 'true' : 'false' );
		muteBtn.classList.toggle( 'is-active', !! state.muted );
		muteBtn.addEventListener( 'click', function () {
			state.muted = ! state.muted;
			muteBtn.classList.toggle( 'is-active', state.muted );
			muteBtn.setAttribute( 'aria-pressed', state.muted ? 'true' : 'false' );
			if ( options.onVolumeChange ) {
				options.onVolumeChange();
			}
		} );
		bottomRow.appendChild( muteBtn );

		if ( options.solo ) {
			var soloBtn = document.createElement( 'button' );
			soloBtn.type = 'button';
			soloBtn.className = 'cnr-player__voice-btn cnr-player__voice-btn--solo';
			soloBtn.textContent = 'S';
			soloBtn.title = 'Solo';
			soloBtn.setAttribute( 'aria-pressed', state.solo ? 'true' : 'false' );
			soloBtn.classList.toggle( 'is-active', !! state.solo );
			soloBtn.addEventListener( 'click', function () {
				state.solo = ! state.solo;
				soloBtn.classList.toggle( 'is-active', state.solo );
				soloBtn.setAttribute( 'aria-pressed', state.solo ? 'true' : 'false' );
				// Solo na JEDNYM kanale (głosie albo podkładzie) wycisza wszystkie pozostałe —
				// dla głosów computeGain czyta stan na bieżąco przy każdej zaplanowanej nucie, ale
				// głośność podkładu (GainNode) trzeba jawnie przeliczyć od razu (patrz
				// isAnySoloActive/applyAudioVolume), inaczej zmieni się dopiero przy następnej
				// zmianie suwaka głośności podkładu.
				if ( options.onVolumeChange ) {
					options.onVolumeChange();
				}
			} );
			bottomRow.appendChild( soloBtn );
		}

		strip.appendChild( bottomRow );

		return strip;
	}

	/**
	 * Wiersz miksera dla podkładu instrumentalnego (opcjonalny plik audio zsynchronizowany
	 * z nutami — patrz też ensureAudioTrackNode/syncAudioToQuarters/applyAudioPlaybackRate
	 * niżej). Ma Mute i Solo tak samo jak każdy głos chóralny (nie ma tylko wyboru brzmienia,
	 * bo to nagranie audio, a nie syntezowany dźwięk).
	 */
	function buildBackingTrackControl( voicesEl, player ) {
		if ( ! voicesEl || ! player.audioEl ) {
			return;
		}
		var strip = buildChannelStrip( player, player.backingTrack, 'Podkład instrumentalny', {
			timbre: false,
			solo: true,
			onVolumeChange: function () {
				applyAudioVolume( player );
			}
		} );
		strip.classList.add( 'cnr-player__voice-row--backing' );
		voicesEl.appendChild( strip );
	}

	/**
	 * Czy JAKIKOLWIEK kanał miksera — głos chóralny ALBO podkład instrumentalny — ma aktualnie
	 * wciśnięte Solo. Używane zarówno przez computeGain (głosy, czytane na bieżąco przy każdej
	 * zaplanowanej nucie), jak i applyAudioVolume (podkład, patrz tam) — dzięki temu Solo na
	 * DOWOLNYM kanale poprawnie wycisza wszystkie pozostałe, niezależnie od tego, czy to głos,
	 * czy podkład.
	 */
	function isAnySoloActive( player ) {
		var voiceSolo = Object.keys( player.voiceStates ).some( function ( k ) {
			return player.voiceStates[ k ].solo;
		} );
		return voiceSolo || !! ( player.backingTrack && player.backingTrack.solo );
	}

	function computeGain( player, key ) {
		var anySolo = isAnySoloActive( player );
		var state = player.voiceStates[ key ];
		if ( ! state ) {
			return 1;
		}
		if ( state.muted ) {
			return 0;
		}
		if ( anySolo && ! state.solo ) {
			return 0;
		}
		return 'number' === typeof state.volume ? state.volume : 1;
	}

	/* -----------------------------------------------------------------
	 * Odtwarzanie dźwięku
	 * --------------------------------------------------------------- */

	function ensureAudioContext( player ) {
		if ( ! player.audioCtx ) {
			var Ctx = window.AudioContext || window.webkitAudioContext;
			player.audioCtx = new Ctx();
			player.audioCtx.onstatechange = function () {
				if ( player.onAudioStateChange ) {
					player.onAudioStateChange();
				}
			};
		}
		return player.audioCtx;
	}

	/**
	 * Prosty, generowany "w locie" pogłos (bez pobierania żadnego pliku dźwiękowego) —
	 * dodaje odrobinę przestrzeni, dzięki czemu generyczne brzmienie GM brzmi mniej sucho
	 * i "syntetycznie". Splot (convolution) na szumie z wykładniczym wygaszaniem to
	 * standardowa, tania technika budowania odpowiedzi impulsowej pomieszczenia.
	 */
	function buildImpulseResponse( ac, durationSeconds, decayPower ) {
		var rate   = ac.sampleRate;
		var length = Math.max( 1, Math.floor( rate * durationSeconds ) );
		var impulse = ac.createBuffer( 2, length, rate );
		for ( var ch = 0; ch < impulse.numberOfChannels; ch++ ) {
			var data = impulse.getChannelData( ch );
			for ( var i = 0; i < length; i++ ) {
				data[ i ] = ( Math.random() * 2 - 1 ) * Math.pow( 1 - i / length, decayPower );
			}
		}
		return impulse;
	}

	/**
	 * Wspólna magistrala efektów (dry/wet pogłos), przez którą przechodzi dźwięk
	 * wszystkich wczytanych instrumentów. Tworzona raz na odtwarzacz.
	 */
	function ensureEffectsBus( player ) {
		if ( player.effectsBus ) {
			return player.effectsBus;
		}
		var ac = player.audioCtx;
		var input = ac.createGain();

		// Wspólny suwak głośności całości (mikser) — wpięty ZA pogłosem, więc reguluje
		// łączną głośność wyjścia niezależnie od proporcji dry/wet.
		var masterGain = ac.createGain();
		masterGain.gain.value = player.masterVolume;
		masterGain.connect( ac.destination );
		player.masterGainNode = masterGain;

		try {
			var dryGain = ac.createGain();
			dryGain.gain.value = 0.85;
			var wetGain = ac.createGain();
			wetGain.gain.value = 0.22;
			var convolver = ac.createConvolver();
			convolver.buffer = buildImpulseResponse( ac, 1.6, 2.4 );

			input.connect( dryGain );
			dryGain.connect( masterGain );
			input.connect( convolver );
			convolver.connect( wetGain );
			wetGain.connect( masterGain );
		} catch ( e ) {
			// Jeśli z jakiegoś powodu ConvolverNode zawiedzie (stara przeglądarka itp.),
			// po prostu puść dźwięk bezpośrednio — brak pogłosu nie powinien blokować odtwarzania.
			input.connect( masterGain );
		}

		player.effectsBus = input;
		return input;
	}

	/* -----------------------------------------------------------------
	 * Podkład instrumentalny (opcjonalny plik audio zsynchronizowany z nutami)
	 * --------------------------------------------------------------- */

	function applyAudioPreservesPitch( audioEl ) {
		try {
			if ( 'preservesPitch' in audioEl ) {
				audioEl.preservesPitch = true;
			}
			if ( 'mozPreservesPitch' in audioEl ) {
				audioEl.mozPreservesPitch = true;
			}
			if ( 'webkitPreservesPitch' in audioEl ) {
				audioEl.webkitPreservesPitch = true;
			}
		} catch ( e ) {
			// ignorowane — bez tego zmiana tempa tylko pogorszy brzmienie podkładu (wyższy/niższy
			// dźwięk), nie zepsuje samego odtwarzania.
		}
	}

	/**
	 * Podpina element <audio> pod magistralę efektów (przez Web Audio GainNode), żeby jego
	 * głośność dało się podbić powyżej 100% tak samo jak głosy w mikserze (zwykła właściwość
	 * audio.volume pozwala tylko na 0–100%). Wymaga gotowego AudioContext — wywoływane dopiero
	 * przy starcie odtwarzania. createMediaElementSource() można wywołać tylko RAZ na dany
	 * element, stąd cache w player.audioTrackGain.
	 */
	function ensureAudioTrackNode( player ) {
		if ( player.audioTrackGain ) {
			return player.audioTrackGain;
		}
		if ( ! player.audioEl || ! player.audioCtx ) {
			return null;
		}
		try {
			var source = player.audioCtx.createMediaElementSource( player.audioEl );
			var gain = player.audioCtx.createGain();
			// Wartość początkowa nieistotna — startPlayback wywołuje applyAudioVolume() zaraz po
			// utworzeniu tego węzła, co ustawi właściwą głośność (z uwzględnieniem Mute/Solo).
			gain.gain.value = 0;
			source.connect( gain );
			gain.connect( player.masterGainNode || player.audioCtx.destination );
			player.audioTrackGain = gain;
		} catch ( e ) {
			// Opcjonalne — jeśli się nie uda (np. bardzo stara przeglądarka), głośność podkładu
			// ograniczy się do zwykłego zakresu 0–100% przez audio.volume (patrz applyAudioVolume).
		}
		return player.audioTrackGain;
	}

	function applyAudioVolume( player ) {
		if ( ! player.audioEl ) {
			return;
		}
		// Tak samo jak computeGain dla głosów: wyciszony -> 0; ktoś inny ma Solo, a podkład nie
		// -> 0; w przeciwnym razie zwykła ustawiona głośność (patrz isAnySoloActive).
		var anySolo = isAnySoloActive( player );
		var audible = ! player.backingTrack.muted && ( ! anySolo || player.backingTrack.solo );
		var vol = audible ? Math.max( 0, player.backingTrack.volume ) : 0;
		if ( player.audioTrackGain ) {
			player.audioTrackGain.gain.value = vol;
			player.audioEl.volume = 1;
		} else {
			player.audioEl.volume = Math.min( 1, vol );
		}
	}

	function applyAudioPlaybackRate( player ) {
		if ( ! player.audioEl ) {
			return;
		}
		try {
			// backingTrack.tempoMultiplier (nie player.tempoMultiplier) — tempo podkładu jest
			// sterowane osobnym suwakiem, niezależnym od tempa nut (patrz rebaseBackingTempo).
			player.audioEl.playbackRate = player.backingTrack.tempoMultiplier;
		} catch ( e ) {
			// ignorowane — brak zmiany tempa podkładu nie powinien przerywać reszty odtwarzania.
		}
	}

	/**
	 * Ustawia moment odtwarzania podkładu audio na podstawie pozycji w utworze (w ćwierćnutach).
	 * Liczymy to w oparciu o BAZOWE tempo z pliku nut (baseBpm), NIE aktualnie ustawione tempo —
	 * bo zmianę tempa realizujemy przez audio.playbackRate (patrz applyAudioPlaybackRate), a nie
	 * przez przeliczanie czasu. Inaczej podkład i nuty rozjeżdżałyby się przy każdej zmianie tempa.
	 */
	function syncAudioToQuarters( player, quarters ) {
		if ( ! player.audioEl ) {
			return;
		}
		var seconds = quarters * ( 60 / player.baseBpm );
		try {
			if ( isFinite( seconds ) && seconds >= 0 ) {
				player.audioEl.currentTime = seconds;
			}
		} catch ( e ) {
			// Niektóre przeglądarki rzucają błąd, jeśli metadane pliku audio jeszcze się nie
			// wczytały — podkład po prostu ruszy od początku zamiast od wskazanego miejsca.
		}
	}

	/* -----------------------------------------------------------------
	 * Brzmienia SoundFont (.sf2) — od 1.13.0. Nazwa brzmienia głosu:
	 *   'choir_aahs' / 'voice_oohs' / 'acoustic_grand_piano' — wbudowane (soundfont-player);
	 *   'sf2:<id SoundFontu>:<bank>:<program>' — preset z pliku .sf2 (assets/js/sf2-player.js).
	 * --------------------------------------------------------------- */
	// Klucz zmieniony w 1.14.0, żeby wybór zapamiętany w 1.13.0 nie zasłaniał nowych domyślnych brzmień z ustawień.
	var SOURCE_STORAGE_KEY = 'cnrSoundSource2';
	var METRONOME_STORAGE_KEY = 'cnrMetronome';
	var ZOOM_STORAGE_KEY = 'cnrScoreZoom';
	var LEAD_STORAGE_KEY = 'cnrHighlightLead';
	var DEFAULT_LEAD_MS = 120;
	var ZOOM_MIN = 0.35;
	var ZOOM_MAX = 1.6;
	var COUNT_IN_STORAGE_KEY = 'cnrCountIn';
	var CHOIR_PRESET_PATTERN = /choir|chór|chor|aah|ooh|voice|vox|chorus/i;
	var PIANO_PRESET_PATTERN = /piano|fortepian|grand/i;

	function storageGet( key ) {
		try {
			return window.localStorage.getItem( key );
		} catch ( e ) {
			return null;
		}
	}

	function storageSet( key, value ) {
		try {
			window.localStorage.setItem( key, value );
		} catch ( e ) {
			// tryb prywatny itp. — wybór po prostu nie zostanie zapamiętany.
		}
	}

	function findSoundfont( player, id ) {
		for ( var i = 0; i < player.soundfonts.length; i++ ) {
			if ( player.soundfonts[ i ].id === id ) {
				return player.soundfonts[ i ];
			}
		}
		return null;
	}

	/**
	 * Zapamiętany wybór chórzysty ('default' | 'builtin' | 'sf2:<id>'), a jeśli go nie ma (albo
	 * SoundFont usunięto) — 'default', czyli brzmienia ustawione przez administratora.
	 */
	function initialSoundSource( soundfonts ) {
		var remembered = storageGet( SOURCE_STORAGE_KEY );
		if ( 'builtin' === remembered || 'default' === remembered ) {
			return remembered;
		}
		if ( remembered && 0 === remembered.indexOf( 'sf2:' ) && soundfonts.some( function ( sf ) {
			return 'sf2:' + sf.id === remembered;
		} ) ) {
			return remembered;
		}
		return 'default';
	}

	function isBuiltinTimbre( value ) {
		return TIMBRE_OPTIONS.some( function ( o ) {
			return o.value === value;
		} );
	}

	/** Czy brzmienie z ustawień jest poprawne: wbudowane albo 'sf2:<id>[:bank:program]' istniejącego SoundFontu. */
	function isValidTimbre( value, soundfonts ) {
		if ( isBuiltinTimbre( value ) ) {
			return true;
		}
		var m = /^sf2:([^:]+)(:\d+:\d+)?$/.exec( value || '' );
		return !! m && soundfonts.some( function ( sf ) {
			return sf.id === m[ 1 ];
		} );
	}

	/** Domyślne brzmienia z atrybutów odtwarzacza (z zapasem na szablon z 1.13.0). */
	function readDefaults( container, soundfonts ) {
		var legacy = container.getAttribute( 'data-default-sound' ) || '';
		legacy = isValidTimbre( legacy, soundfonts ) ? legacy : '';
		var voice  = container.getAttribute( 'data-default-voice' ) || legacy;
		var accomp = container.getAttribute( 'data-default-accomp' ) || legacy;
		return {
			voice: isValidTimbre( voice, soundfonts ) ? voice : DEFAULT_VOICE_TIMBRE,
			accomp: isValidTimbre( accomp, soundfonts ) ? accomp : 'acoustic_grand_piano'
		};
	}

	function defaultsAreStandard( player ) {
		return ! player.defaults || ( DEFAULT_VOICE_TIMBRE === player.defaults.voice && 'acoustic_grand_piano' === player.defaults.accomp );
	}

	/** Krótki opis domyślnych brzmień do listy „Brzmienia”, np. „Choir Aahs / Fortepian”. */
	function describeDefaults( player ) {
		function name( value ) {
			for ( var i = 0; i < TIMBRE_OPTIONS.length; i++ ) {
				if ( TIMBRE_OPTIONS[ i ].value === value ) {
					return TIMBRE_OPTIONS[ i ].label;
				}
			}
			var parts = String( value ).split( ':' );
			var sf = findSoundfont( player, parts[ 1 ] );
			var bank = player.banks[ parts[ 1 ] ];
			if ( bank && parts.length >= 4 ) {
				var preset = bank.findPreset( parts[ 2 ] + ':' + parts[ 3 ] );
				if ( preset ) {
					return preset.name;
				}
			}
			return sf ? sf.name : value;
		}
		var d = player.defaults || { voice: DEFAULT_VOICE_TIMBRE, accomp: 'acoustic_grand_piano' };
		return name( d.voice ) + ' / ' + name( d.accomp );
	}

	function builtinDefaultFor( label ) {
		return ACCOMPANIMENT_PATTERN.test( label ) ? 'acoustic_grand_piano' : DEFAULT_VOICE_TIMBRE;
	}

	/**
	 * Preset SoundFontu dla głosu: dla akompaniamentu — fortepian (nazwa albo GM 0:0), dla
	 * głosów chóralnych — chór (nazwa albo GM „Choir Aahs” 0:52 / „Voice Oohs” 0:53); gdy plik
	 * takich nie ma — jego domyślny preset.
	 */
	function defaultPresetFor( bank, label ) {
		var presets = bank.getPresets();
		var accompaniment = ACCOMPANIMENT_PATTERN.test( label );
		var pattern = accompaniment ? PIANO_PRESET_PATTERN : CHOIR_PRESET_PATTERN;
		var gm = accompaniment ? [ '0:0' ] : [ '0:52', '0:53' ];
		var i;
		for ( i = 0; i < presets.length; i++ ) {
			if ( pattern.test( presets[ i ].name ) ) {
				return presets[ i ].key;
			}
		}
		for ( i = 0; i < gm.length; i++ ) {
			if ( bank.findPreset( gm[ i ] ) ) {
				return gm[ i ];
			}
		}
		return bank.getDefaultPresetKey() || ( presets[ 0 ] ? presets[ 0 ].key : '0:0' );
	}

	/** Wczytuje plik .sf2 (raz na stronę; przeglądarka zapamiętuje go też w pamięci podręcznej). */
	function loadBank( player, id ) {
		if ( player.banks[ id ] ) {
			return Promise.resolve( player.banks[ id ] );
		}
		var sf = findSoundfont( player, id );
		var lib = window.CNR && window.CNR.SoundFont;
		if ( ! sf || ! lib ) {
			return Promise.reject( new Error( 'Brak pliku SoundFont.' ) );
		}
		var statusEl = player.statusEl;
		var shown = 'Wczytywanie brzmień „' + sf.name + '”…';
		setStatus( statusEl, shown, false );
		return lib.loadSoundFont( sf.url, function ( loaded, total ) {
			var text = total
				? 'Wczytywanie brzmień „' + sf.name + '”… ' + Math.round( loaded / total * 100 ) + '%'
				: 'Wczytywanie brzmień „' + sf.name + '”… ' + ( loaded / 1048576 ).toFixed( 1 ).replace( '.', ',' ) + ' MB';
			if ( statusEl && statusEl.textContent === shown ) {
				setStatus( statusEl, text, false );
			}
			shown = text;
		} ).then( function ( bank ) {
			player.banks[ id ] = bank;
			if ( statusEl && statusEl.textContent === shown ) {
				setStatus( statusEl, '', false );
			}
			return bank;
		}, function ( err ) {
			setStatus( statusEl, 'Nie udało się wczytać brzmień „' + sf.name + '”: ' + ( err && err.message ? err.message : err ) + ' Gra brzmienie wbudowane.', true );
			throw err;
		} );
	}

	function rebuildMixer( player ) {
		if ( ! player.voicesEl || ! player.schedule ) {
			return;
		}
		buildVoiceControls( player.voicesEl, player );
		buildBackingTrackControl( player.voicesEl, player );
	}

	/** Opcje wyboru brzmienia głosu: wbudowane + presety wczytanych SoundFontów (+ niewczytane do wczytania). */
	function fillTimbreSelect( player, select ) {
		var builtinGroup = select;
		if ( player.soundfonts.length ) {
			builtinGroup = document.createElement( 'optgroup' );
			builtinGroup.label = 'Wbudowane';
			select.appendChild( builtinGroup );
		}
		TIMBRE_OPTIONS.forEach( function ( opt ) {
			var optionEl = document.createElement( 'option' );
			optionEl.value = opt.value;
			optionEl.textContent = opt.label;
			builtinGroup.appendChild( optionEl );
		} );
		player.soundfonts.forEach( function ( sf ) {
			var bank = player.banks[ sf.id ];
			if ( ! bank ) {
				var lazy = document.createElement( 'option' );
				lazy.value = 'sf2:' + sf.id;
				lazy.textContent = 'SoundFont: ' + sf.name + '…';
				select.appendChild( lazy );
				return;
			}
			var group = document.createElement( 'optgroup' );
			group.label = sf.name;
			bank.getPresets().forEach( function ( p ) {
				var o = document.createElement( 'option' );
				o.value = 'sf2:' + sf.id + ':' + p.key;
				o.textContent = p.name;
				group.appendChild( o );
			} );
			select.appendChild( group );
		} );
	}

	/**
	 * Brzmienie docelowe głosu dla wybranego źródła:
	 *   'default'  — ustawione przez administratora (osobno głosy i akompaniament);
	 *   'builtin'  — Chór (Aahs) / Fortepian;
	 *   'sf2:<id>' — SoundFont z automatycznym doborem (chór / fortepian).
	 * Może to być 'sf2:<id>' bez konkretnego brzmienia — dobierane po wczytaniu pliku.
	 */
	function targetTimbre( player, source, label ) {
		if ( 'default' === source ) {
			var d = player.defaults || {};
			return ( ACCOMPANIMENT_PATTERN.test( label ) ? d.accomp : d.voice ) || builtinDefaultFor( label );
		}
		if ( source && 0 === source.indexOf( 'sf2:' ) ) {
			return source;
		}
		return builtinDefaultFor( label );
	}

	/** Pełna nazwa brzmienia po wczytaniu pliku: 'sf2:<id>' -> 'sf2:<id>:<bank>:<program>'; brak brzmienia w pliku -> dobór automatyczny. */
	function resolveTimbre( target, bank, label ) {
		var parts = target.split( ':' );
		if ( parts.length >= 4 && bank.findPreset( parts[ 2 ] + ':' + parts[ 3 ] ) ) {
			return target;
		}
		return 'sf2:' + parts[ 1 ] + ':' + defaultPresetFor( bank, label );
	}

	/**
	 * Brzmienia dla wszystkich głosów naraz (patrz targetTimbre). Wybór jest zapamiętywany
	 * w przeglądarce. Gdy pliku SoundFont nie da się wczytać — głosy z tego pliku grają
	 * brzmieniami wbudowanymi.
	 */
	function applySoundSource( player, source ) {
		source = source || 'default';
		player.soundSource = source;
		if ( ! player.schedule ) {
			return Promise.resolve();
		}
		storageSet( SOURCE_STORAGE_KEY, source );
		var voices = player.schedule.voices;
		var targets = {};
		var bankIds = [];
		voices.forEach( function ( v ) {
			var t = targetTimbre( player, source, v.label );
			targets[ v.key ] = t;
			if ( 0 === t.indexOf( 'sf2:' ) ) {
				var id = t.split( ':' )[ 1 ];
				if ( -1 === bankIds.indexOf( id ) ) {
					bankIds.push( id );
				}
			} else {
				player.voiceStates[ v.key ].instrument = t;
			}
		} );
		rebuildMixer( player );
		if ( ! bankIds.length ) {
			return ensureVoiceInstrumentsLoaded( player ).catch( function () {} );
		}
		return Promise.all( bankIds.map( function ( id ) {
			return loadBank( player, id ).catch( function () {
				return null;
			} );
		} ) ).then( function ( banks ) {
			if ( player.soundSource !== source ) {
				return null; // w międzyczasie wybrano coś innego
			}
			voices.forEach( function ( v ) {
				var t = targets[ v.key ];
				if ( 0 !== t.indexOf( 'sf2:' ) ) {
					return;
				}
				var bank = banks[ bankIds.indexOf( t.split( ':' )[ 1 ] ) ];
				player.voiceStates[ v.key ].instrument = bank ? resolveTimbre( t, bank, v.label ) : builtinDefaultFor( v.label );
			} );
			rebuildMixer( player );
			return ensureVoiceInstrumentsLoaded( player ).catch( function () {} );
		} );
	}

	/**
	 * Wczytuje (albo zwraca z pamięci podręcznej) brzmienie o podanej nazwie. Każdy głos może
	 * teraz mieć inne brzmienie (patrz voiceStates[key].instrument, ustawiane w buildFlatNotes
	 * i zmieniane wyborem w mikserze — buildVoiceControls), więc w danym momencie może być
	 * wczytanych/używanych naraz kilka różnych brzmień — stąd zwykła pamięć podręczna
	 * player.instrumentCache (bez pojedynczego "aktualnego" brzmienia).
	 */
	function loadInstrument( player, name ) {
		var ac = ensureAudioContext( player );
		name = name || DEFAULT_VOICE_TIMBRE;

		if ( player.instrumentCache[ name ] ) {
			return Promise.resolve( player.instrumentCache[ name ] );
		}

		if ( 0 === name.indexOf( 'sf2:' ) ) {
			// Preset z pliku .sf2: 'sf2:<id>:<bank>:<program>' (od 1.13.0).
			var parts = name.split( ':' );
			return loadBank( player, parts[ 1 ] ).then( function ( bank ) {
				var presetKey = parts.length >= 4 ? parts[ 2 ] + ':' + parts[ 3 ] : bank.getDefaultPresetKey();
				if ( player.audioCtx !== ac ) {
					return loadInstrument( player, name ); // kontekst audio wymieniony w międzyczasie
				}
				var instrument = bank.createInstrument( ac, presetKey, { destination: ensureEffectsBus( player ) } );
				player.instrumentCache[ name ] = instrument;
				return instrument;
			} );
		}

		if ( typeof Soundfont === 'undefined' ) {
			return Promise.reject( new Error( 'Brak biblioteki soundfont-player.' ) );
		}

		var options = {
			// MusyngKite to zestaw brzmień o wyraźnie lepszej jakości próbek niż domyślny
			// alternatywny FluidR3_GM (kosztem nieco dłuższego wczytywania).
			soundfont: 'MusyngKite',
			format: 'mp3',
			destination: ensureEffectsBus( player )
		};
		if ( 'acoustic_grand_piano' !== name ) {
			// Głosom (chór/oohs) dajemy odrobinę dłuższe wybrzmienie, żeby dźwięk kończył się
			// miękko zamiast ucinać się "cyfrowo" — bliżej naturalnego śpiewu niż perkusyjny atak.
			options.attack  = 0.05;
			options.release = 0.35;
		}

		return Soundfont.instrument( ac, name, options ).then( function ( instrument ) {
			if ( player.audioCtx !== ac ) {
				return loadInstrument( player, name ); // kontekst audio wymieniony w międzyczasie
			}
			player.instrumentCache[ name ] = instrument;
			return instrument;
		} );
	}

	/** Nazwy wszystkich brzmień aktualnie wybranych w mikserze (co najmniej jedno, każdego rodzaju raz). */
	function collectUsedInstrumentNames( player ) {
		var seen = {};
		if ( player.schedule && player.schedule.voices ) {
			player.schedule.voices.forEach( function ( voice ) {
				var state = player.voiceStates[ voice.key ];
				seen[ ( state && state.instrument ) || DEFAULT_VOICE_TIMBRE ] = true;
			} );
		}
		var names = Object.keys( seen );
		return names.length ? names : [ DEFAULT_VOICE_TIMBRE ];
	}

	/** Wczytuje wszystkie brzmienia aktualnie potrzebne przez głosy utworu, zanim ruszy odtwarzanie. */
	function ensureVoiceInstrumentsLoaded( player ) {
		return Promise.all( collectUsedInstrumentNames( player ).map( function ( name ) {
			return loadInstrument( player, name );
		} ) );
	}

	/** Zatrzymuje dźwięk wszystkich wczytanych brzmień naraz (zamiast jednego "aktualnego"). */
	function stopAllInstruments( player ) {
		Object.keys( player.instrumentCache ).forEach( function ( name ) {
			var instrument = player.instrumentCache[ name ];
			if ( instrument && instrument.stop ) {
				try {
					instrument.stop();
				} catch ( e ) {
					// ignorowane — zatrzymanie dźwięku jest tylko "sprzątaniem" przy pauzie/przewijaniu.
				}
			}
		} );
		stopClicks( player );
	}

	/* -----------------------------------------------------------------
	 * Dźwięk na iPhonie / iPadzie (od 1.15.1)
	 * --------------------------------------------------------------- */

	function isIOS() {
		var ua = navigator.userAgent || '';
		return /iPad|iPhone|iPod/.test( ua ) || ( 'MacIntel' === navigator.platform && navigator.maxTouchPoints > 1 );
	}

	/**
	 * Wywoływane SYNCHRONICZNIE w reakcji na dotknięcie „Odtwórz”:
	 *  - iOS 17+: sesja audio „playback” — dźwięk gra mimo przełącznika wyciszenia (domyślnie
	 *    Safari traktuje Web Audio jak dźwięki systemowe, które przełącznik wycisza);
	 *  - starsze iOS: ciche, zapętlone nagranie w elemencie <audio> przełącza telefon w ten
	 *    sam tryb „odtwarzania multimediów”;
	 *  - wznowienie kontekstu w KAŻDYM stanie innym niż „running” (iOS używa też stanu
	 *    „interrupted” — po rozmowie, Siri, powrocie z tła), a gdy wcześniej nie dał się
	 *    wznowić — nowy kontekst;
	 *  - jednorazowo cisza przez Web Audio (starsze iOS „odblokowują” dźwięk dopiero po
	 *    faktycznym odtworzeniu czegoś w ramach dotknięcia).
	 */
	function unlockAudio( player ) {
		try {
			if ( navigator.audioSession && 'playback' !== navigator.audioSession.type ) {
				navigator.audioSession.type = 'playback';
			}
		} catch ( e ) {
			// starsza przeglądarka
		}
		if ( player.audioNeedsReset && player.audioCtx && 'running' !== player.audioCtx.state ) {
			resetAudioContext( player );
		}
		player.audioNeedsReset = false;
		var ac = ensureAudioContext( player );
		if ( 'running' !== ac.state ) {
			try {
				var p = ac.resume();
				if ( p && p.catch ) {
					p.catch( function () {} );
				}
			} catch ( e ) {
				// obsłużone niżej (kontrola stanu po starcie)
			}
		}
		try {
			var buffer = ac.createBuffer( 1, 1, ac.sampleRate );
			var src = ac.createBufferSource();
			src.buffer = buffer;
			src.connect( ac.destination );
			src.start( 0 );
		} catch ( e ) {
			// tylko „odblokowanie”
		}
		if ( isIOS() && ! navigator.audioSession ) {
			startSilentKeepAlive( player );
		}
		return ac;
	}

	/** Nowy kontekst audio zamiast takiego, którego iOS nie pozwala już wznowić. */
	function resetAudioContext( player ) {
		if ( player.audioTrackGain ) {
			return; // podkład jest podpięty do starego kontekstu na stałe — zostajemy przy nim
		}
		try {
			stopAllInstruments( player );
			player.audioCtx.close();
		} catch ( e ) {
			// ignorowane
		}
		player.audioCtx = null;
		player.effectsBus = null;
		player.masterGainNode = null;
		player.clickGain = null;
		player.instrumentCache = {};
	}

	var silentWavUrl = null;

	/** 0,5 s ciszy w formacie WAV (8 kHz, 8 bit) jako data: URL — bez pobierania pliku. */
	function getSilentWavUrl() {
		if ( silentWavUrl ) {
			return silentWavUrl;
		}
		var samples = 4000;
		var bytes = new Uint8Array( 44 + samples );
		var view = new DataView( bytes.buffer );
		function str( offset, text ) {
			for ( var i = 0; i < text.length; i++ ) {
				bytes[ offset + i ] = text.charCodeAt( i );
			}
		}
		str( 0, 'RIFF' );
		view.setUint32( 4, 36 + samples, true );
		str( 8, 'WAVEfmt ' );
		view.setUint32( 16, 16, true );
		view.setUint16( 20, 1, true );
		view.setUint16( 22, 1, true );
		view.setUint32( 24, 8000, true );
		view.setUint32( 28, 8000, true );
		view.setUint16( 32, 1, true );
		view.setUint16( 34, 8, true );
		str( 36, 'data' );
		view.setUint32( 40, samples, true );
		for ( var j = 0; j < samples; j++ ) {
			bytes[ 44 + j ] = 128;
		}
		var bin = '';
		for ( var k = 0; k < bytes.length; k++ ) {
			bin += String.fromCharCode( bytes[ k ] );
		}
		silentWavUrl = 'data:audio/wav;base64,' + window.btoa( bin );
		return silentWavUrl;
	}

	function startSilentKeepAlive( player ) {
		try {
			if ( ! player.silentAudio ) {
				var el = document.createElement( 'audio' );
				el.setAttribute( 'playsinline', '' );
				el.setAttribute( 'x-webkit-airplay', 'deny' );
				el.loop = true;
				el.preload = 'auto';
				el.src = getSilentWavUrl();
				player.silentAudio = el;
			}
			var p = player.silentAudio.play();
			if ( p && p.catch ) {
				p.catch( function () {} );
			}
		} catch ( e ) {
			// tylko wsparcie dla starszych iPhone'ów
		}
	}

	function stopSilentKeepAlive( player ) {
		if ( player.silentAudio ) {
			try {
				player.silentAudio.pause();
			} catch ( e ) {
				// ignorowane
			}
		}
	}

	/**
	 * Gdy system zatrzyma dźwięk w trakcie grania (połączenie, Siri, wyjście z przeglądarki),
	 * zatrzymujemy też odtwarzacz — zamiast „grać” po cichu z biegnącym podświetleniem — i
	 * mówimy, co zrobić. Po powrocie do strony próbujemy wznowić kontekst.
	 */
	function setupAudioLifecycle( player ) {
		var playBtn = player.container.querySelector( '.cnr-player__play' );
		var statusEl = player.container.querySelector( '.cnr-player__status' );
		player.onAudioStateChange = function () {
			var ac = player.audioCtx;
			if ( ac && player.isPlaying && ( 'interrupted' === ac.state || 'suspended' === ac.state ) ) {
				pausePlayback( player, playBtn );
				setStatus( statusEl, 'Odtwarzanie przerwane przez telefon — dotknij „Odtwórz”, żeby grać dalej.', false );
			}
		};
		document.addEventListener( 'visibilitychange', function () {
			var ac = player.audioCtx;
			if ( 'visible' === document.visibilityState && ac && 'running' !== ac.state && 'closed' !== ac.state ) {
				try {
					ac.resume().catch( function () {} );
				} catch ( e ) {
					// wznowi się przy następnym „Odtwórz”
				}
			}
		} );
	}

	/* -----------------------------------------------------------------
	 * Kompaktowe przyciski i rozmiar nut (od 1.15.1)
	 * --------------------------------------------------------------- */

	/** Przycisk z ikoną i opisem — na telefonie widać samą ikonę (opis w aria-label). */
	function setIconLabel( btn, icon, label ) {
		if ( ! btn ) {
			return;
		}
		btn.innerHTML = '';
		var i = document.createElement( 'span' );
		i.className = 'cnr-player__btn-icon';
		i.setAttribute( 'aria-hidden', 'true' );
		i.textContent = icon;
		var l = document.createElement( 'span' );
		l.className = 'cnr-player__btn-label';
		l.textContent = label;
		btn.appendChild( i );
		btn.appendChild( l );
		btn.setAttribute( 'aria-label', label );
		btn.title = label;
	}

	function setPlayLabel( btn, playing ) {
		setIconLabel( btn, playing ? '⏸' : '▶', playing ? 'Pauza' : 'Odtwórz' );
	}

	/** Rozmiar nut „automatycznie”: pełny na komputerze, proporcjonalnie mniejszy na wąskim ekranie. */
	function autoZoom( player ) {
		var scoreEl = player.container.querySelector( '.cnr-player__score' );
		var width = scoreEl ? scoreEl.clientWidth : 800;
		return Math.max( 0.45, Math.min( 1, width / 760 ) );
	}

	function effectiveZoom( player ) {
		return player.zoomPref ? Math.max( ZOOM_MIN, Math.min( ZOOM_MAX, player.zoomPref ) ) : autoZoom( player );
	}

	function updateZoomLabel( player ) {
		if ( player.zoomLabelEl ) {
			var pct = Math.round( effectiveZoom( player ) * 100 ) + '%';
			player.zoomLabelEl.textContent = player.zoomPref ? pct : 'Auto ' + pct;
		}
	}

	/** Przyciski „Nuty: − / Auto / +” w panelu sterowania. */
	function setupZoomControls( player ) {
		var toolbar = player.container.querySelector( '.cnr-player__controls-extra .cnr-player__toolbar' );
		if ( ! toolbar || toolbar.querySelector( '.cnr-player__zoom' ) ) {
			return;
		}
		var group = document.createElement( 'span' );
		group.className = 'cnr-player__zoom';
		var caption = document.createElement( 'span' );
		caption.className = 'cnr-player__zoom-caption';
		caption.textContent = 'Nuty:';
		function makeBtn( cls, text, title ) {
			var b = document.createElement( 'button' );
			b.type = 'button';
			b.className = cls;
			b.textContent = text;
			b.title = title;
			b.setAttribute( 'aria-label', title );
			return b;
		}
		var minus = makeBtn( 'cnr-player__zoom-out', '−', 'Mniejsze nuty' );
		var label = makeBtn( 'cnr-player__zoom-reset', 'Auto', 'Rozmiar nut dopasowany do ekranu' );
		var plus  = makeBtn( 'cnr-player__zoom-in', '+', 'Większe nuty' );
		player.zoomLabelEl = label;
		function apply( pref ) {
			player.zoomPref = pref;
			storageSet( ZOOM_STORAGE_KEY, pref ? String( Math.round( pref * 100 ) / 100 ) : '' );
			updateZoomLabel( player );
			if ( player.schedule ) {
				rerenderScore( player );
			}
		}
		minus.addEventListener( 'click', function () {
			apply( Math.max( ZOOM_MIN, effectiveZoom( player ) / 1.15 ) );
		} );
		plus.addEventListener( 'click', function () {
			apply( Math.min( ZOOM_MAX, effectiveZoom( player ) * 1.15 ) );
		} );
		label.addEventListener( 'click', function () {
			apply( 0 );
		} );
		group.appendChild( caption );
		group.appendChild( minus );
		group.appendChild( label );
		group.appendChild( plus );
		var printBtn = toolbar.querySelector( '.cnr-player__print' );
		toolbar.insertBefore( group, printBtn || null );
		updateZoomLabel( player );
	}

	function readLeadPref() {
		var v = storageGet( LEAD_STORAGE_KEY );
		var n = null === v || '' === v || undefined === v ? NaN : parseInt( v, 10 );
		return isNaN( n ) ? DEFAULT_LEAD_MS : Math.max( -300, Math.min( 600, n ) );
	}

	/** Suwak „Podświetlenie: wcześniej / później” — wyprzedzenie podświetlenia względem dźwięku. */
	function setupLeadControl( player ) {
		var toolbar = player.container.querySelector( '.cnr-player__controls-extra .cnr-player__toolbar' );
		if ( ! toolbar || toolbar.querySelector( '.cnr-player__lead' ) ) {
			return;
		}
		var label = document.createElement( 'label' );
		label.className = 'cnr-player__lead-label';
		label.title = 'Przesuń w prawo, jeśli podświetlenie nut spóźnia się względem dźwięku (np. przy słuchawkach Bluetooth); w lewo, jeśli się spieszy.';
		var caption = document.createElement( 'span' );
		caption.textContent = 'Podświetlenie:';
		var range = document.createElement( 'input' );
		range.type = 'range';
		range.className = 'cnr-player__lead';
		range.min = '-300';
		range.max = '600';
		range.step = '20';
		range.value = String( player.highlightLeadMs );
		range.setAttribute( 'aria-label', 'Wyprzedzenie podświetlenia nut względem dźwięku, w milisekundach' );
		var value = document.createElement( 'span' );
		value.className = 'cnr-player__lead-value';
		function show() {
			var ms = player.highlightLeadMs;
			value.textContent = 0 === ms ? 'równo z dźwiękiem' : ( ms > 0 ? ms + ' ms wcześniej' : ( -ms ) + ' ms później' );
		}
		range.addEventListener( 'input', function () {
			player.highlightLeadMs = parseInt( range.value, 10 ) || 0;
			storageSet( LEAD_STORAGE_KEY, String( player.highlightLeadMs ) );
			show();
		} );
		var reset = document.createElement( 'button' );
		reset.type = 'button';
		reset.className = 'cnr-player__lead-reset';
		reset.textContent = '↺';
		reset.title = 'Przywróć domyślne (' + DEFAULT_LEAD_MS + ' ms wcześniej)';
		reset.setAttribute( 'aria-label', reset.title );
		reset.addEventListener( 'click', function ( e ) {
			e.preventDefault();
			player.highlightLeadMs = DEFAULT_LEAD_MS;
			range.value = String( DEFAULT_LEAD_MS );
			storageSet( LEAD_STORAGE_KEY, '' );
			show();
		} );
		label.appendChild( caption );
		label.appendChild( range );
		label.appendChild( value );
		label.appendChild( reset );
		var printBtn = toolbar.querySelector( '.cnr-player__print' );
		toolbar.insertBefore( label, printBtn || null );
		show();
	}

	/**
	 * Ponowne ułożenie nut (zmiana rozmiaru albo szerokości ekranu) — z nowymi pozycjami do
	 * klikania i kursorem przywróconym w miejscu, w którym akurat jest odtwarzanie.
	 */
	function rerenderScore( player ) {
		var scoreEl = player.container.querySelector( '.cnr-player__score' );
		var position = player.isPlaying && player.audioCtx ? audibleQuarters( player ) : player.playStartQuarters;
		var showCursor = player.isPlaying || player.isPaused || position > 0;
		try {
			player.osmd.Zoom = effectiveZoom( player );
			player.osmd.render();
		} catch ( e ) {
			return;
		}
		player.renderedWidth = scoreEl ? scoreEl.clientWidth : 0;
		var rebuilt = buildCursorSteps( player.osmd );
		player.cursorSteps = rebuilt.steps;
		player.notePositions = rebuilt.positions;
		player.positionsOrigin = scoreOrigin( scoreEl );
		player.cursorCallsMade = 0;
		player.lastScrollTargetY = null;
		if ( showCursor ) {
			repositionCursor( player, position );
		}
		updateZoomLabel( player );
	}

	/* -----------------------------------------------------------------
	 * Metronom (od 1.15.0) — krótkie „tyknięcia” generowane w przeglądarce (bez plików
	 * dźwiękowych), zaplanowane w tym samym zegarze audio co nuty, więc idealnie równo z nimi.
	 * --------------------------------------------------------------- */

	function setupMetronomeControls( player ) {
		var toolbar = player.container.querySelector( '.cnr-player__controls .cnr-player__toolbar' );
		if ( ! toolbar || toolbar.querySelector( '.cnr-player__metronome' ) ) {
			return;
		}
		var btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.className = 'cnr-player__metronome';
		btn.title = 'Metronom: tyknięcie na każdą miarę taktu (pierwsza akcentowana)';
		var countLabel = document.createElement( 'label' );
		countLabel.className = 'cnr-player__count-in';
		countLabel.title = 'Przed rozpoczęciem odtwarzania metronom odlicza jeden takt';
		var countBox = document.createElement( 'input' );
		countBox.type = 'checkbox';
		countBox.className = 'cnr-player__count-in-checkbox';
		countLabel.appendChild( countBox );
		var countLong = document.createElement( 'span' );
		countLong.className = 'cnr-player__btn-label';
		countLong.textContent = 'Odliczanie';
		var countShort = document.createElement( 'span' );
		countShort.className = 'cnr-player__btn-short';
		countShort.textContent = '1-2-3';
		countLabel.appendChild( countLong );
		countLabel.appendChild( countShort );

		function render() {
			setIconLabel( btn, '♩', player.metronome ? 'Metronom: wł.' : 'Metronom: wył.' );
			btn.setAttribute( 'aria-pressed', player.metronome ? 'true' : 'false' );
			btn.classList.toggle( 'cnr-player__metronome--on', player.metronome );
			countBox.checked = player.countIn;
		}
		btn.addEventListener( 'click', function () {
			setMetronome( player, ! player.metronome );
			render();
		} );
		countBox.addEventListener( 'change', function () {
			player.countIn = countBox.checked;
			storageSet( COUNT_IN_STORAGE_KEY, player.countIn ? '1' : '0' );
		} );
		var collapse = toolbar.querySelector( '.cnr-player__collapse-toggle' );
		toolbar.insertBefore( btn, collapse );
		toolbar.insertBefore( countLabel, collapse );
		render();
	}

	function setMetronome( player, on ) {
		player.metronome = !! on;
		storageSet( METRONOME_STORAGE_KEY, player.metronome ? '1' : '0' );
		if ( ! player.metronome ) {
			stopClicks( player );
		} else if ( player.isPlaying && player.audioCtx && player.schedule ) {
			// Włączony w trakcie grania — tyka od najbliższej miary.
			player.clickIndex = findScheduleIndex( player.schedule.clicks || [], audibleQuarters( player ) );
		}
	}

	/** Jedno tyknięcie o czasie `when` (zegar audio); akcent — wyżej i głośniej. */
	function playClick( player, when, accent ) {
		var ac = player.audioCtx;
		if ( ! player.clickGain ) {
			player.clickGain = ac.createGain();
			player.clickGain.gain.value = 0.9;
			// Za suwakiem głośności całości, ale z pominięciem pogłosu — metronom ma być suchy.
			ensureEffectsBus( player );
			player.clickGain.connect( player.masterGainNode || ac.destination );
		}
		var osc = ac.createOscillator();
		var env = ac.createGain();
		osc.type = 'square';
		osc.frequency.value = accent ? 1760 : 1175;
		env.gain.setValueAtTime( 0.0001, when );
		env.gain.exponentialRampToValueAtTime( accent ? 0.5 : 0.3, when + 0.002 );
		env.gain.exponentialRampToValueAtTime( 0.0001, when + 0.05 );
		osc.connect( env );
		env.connect( player.clickGain );
		osc.start( when );
		osc.stop( when + 0.06 );
		player.clickNodes.push( osc );
		osc.onended = function () {
			var i = player.clickNodes.indexOf( osc );
			if ( -1 !== i ) {
				player.clickNodes.splice( i, 1 );
			}
		};
	}

	/** Planuje tyknięcia metronomu do horyzontu harmonogramu (jak nuty w schedulerTick). */
	function scheduleClicks( player, horizonQuarters, bpm ) {
		var clicks = player.schedule && player.schedule.clicks;
		if ( ! clicks ) {
			return;
		}
		var ac = player.audioCtx;
		while ( player.clickIndex < clicks.length && clicks[ player.clickIndex ].start <= horizonQuarters ) {
			var c = clicks[ player.clickIndex ];
			if ( player.metronome && c.start >= player.playStartQuarters - 1e-6 ) {
				var when = player.playStartAudioTime + ( c.start - player.playStartQuarters ) * ( 60 / bpm );
				if ( when >= ac.currentTime ) {
					playClick( player, when, c.accent );
				}
			}
			player.clickIndex++;
		}
	}

	/**
	 * Odliczanie przed startem: pełny takt (wg metrum miejsca, od którego startujemy) tyknięć
	 * zaczynając od `startTime`. Zwraca jego długość w sekundach.
	 */
	function scheduleCountIn( player, startTime ) {
		var spans = ( player.schedule && player.schedule.meterSpans ) || [];
		var span = spans[ 0 ];
		for ( var i = 0; i < spans.length; i++ ) {
			if ( spans[ i ].start <= player.playStartQuarters + 1e-6 ) {
				span = spans[ i ];
			}
		}
		var unit = span ? span.unit : 1;
		var barBeats = span ? Math.max( 1, Math.round( span.nominal / unit ) ) : 4;
		// Na którą miarę taktu wchodzi muzyka: przedtakt (krótszy pierwszy takt) — na końcówkę
		// taktu, np. „4” w 4/4; start w środku taktu (po kliknięciu w nuty) — na tę miarę.
		var startBeat = 0;
		if ( span ) {
			var into = ( player.playStartQuarters - span.start ) / unit;
			var pickup = ( span.offset || 0 ) / unit;
			startBeat = ( ( Math.round( into + pickup ) % barBeats ) + barBeats ) % barBeats;
		}
		// Odliczamy od „raz” do miary wejścia („1 2 3” przed przedtaktem na „4”); gdy to mniej
		// niż dwie miary — dokładamy cały takt.
		var beats = startBeat < 2 ? startBeat + barBeats : startBeat;
		var secPerBeat = unit * 60 / currentBpm( player );
		for ( var b = 0; b < beats; b++ ) {
			playClick( player, startTime + b * secPerBeat, 0 === ( ( ( startBeat - beats + b ) % barBeats ) + barBeats ) % barBeats );
		}
		return beats * secPerBeat;
	}

	/** Zatrzymuje zaplanowane tyknięcia (pauza / stop / przewinięcie / wyłączenie metronomu). */
	function stopClicks( player ) {
		player.clickNodes.slice().forEach( function ( osc ) {
			try {
				osc.disconnect();
			} catch ( e ) {
				// już odłączony
			}
		} );
		player.clickNodes = [];
		if ( player.countInTimer ) {
			clearTimeout( player.countInTimer );
			player.countInTimer = null;
		}
	}

	function startPlayback( player, playBtn, progressBar ) {
		var ac = ensureAudioContext( player );

		return ensureVoiceInstrumentsLoaded( player ).then( function () {
			return ac.resume();
		} ).then( function () {
			if ( ! player.isPaused ) {
				player.scheduleIndex = 0;
				player.playStartQuarters = 0;
				player.cursorCallsMade = 0;
				try {
					player.osmd.cursor.reset();
					player.osmd.cursor.show();
				} catch ( e ) {
					// kursor niedostępny — odtwarzanie dźwięku i tak działa.
				}
			}

			player.playStartAudioTime = ac.currentTime + 0.15;
			player.clickIndex = findScheduleIndex( ( player.schedule && player.schedule.clicks ) || [], player.playStartQuarters );
			// Odliczanie: jeden takt uderzeń metronomu, a dopiero potem nuty (i podkład).
			var countInSeconds = player.countIn ? scheduleCountIn( player, player.playStartAudioTime ) : 0;
			player.playStartAudioTime += countInSeconds;
			player.isPlaying = true;
			player.isPaused  = false;
			setPlayLabel( playBtn, true );

			boostCursorVisibility( player );

			if ( player.audioEl ) {
				ensureAudioTrackNode( player );
				applyAudioVolume( player );
				applyAudioPlaybackRate( player );
				syncAudioToQuarters( player, player.playStartQuarters );
				var startAudio = function () {
					player.countInTimer = null;
					var audioPlayPromise = player.audioEl.play();
					if ( audioPlayPromise && audioPlayPromise.catch ) {
						audioPlayPromise.catch( function () {
							// Autoodtwarzanie podkładu zablokowane przez przeglądarkę (rzadkie, bo
							// wywołujemy to z tej samej reakcji na gest użytkownika co resztę dźwięku) —
							// reszta odtwarzacza (nuty + głosy) i tak działa normalnie, tylko bez podkładu.
						} );
					}
				};
				// Podkład rusza razem z pierwszą nutą (nuty startują z małym zapasem, a po
				// odliczaniu — takt później). Wcześniej podkład startował od razu i wyprzedzał nuty
				// i podświetlenie o ok. 0,15 s.
				var audioDelayMs = Math.round( Math.max( 0, player.playStartAudioTime - ac.currentTime ) * 1000 );
				if ( audioDelayMs > 5 ) {
					player.countInTimer = setTimeout( startAudio, audioDelayMs );
				} else {
					startAudio();
				}
			}

			schedulerTick( player, playBtn, progressBar );
		} );
	}

	/**
	 * Kursor OSMD domyślnie dostaje ujemny z-index (chyba że wykryje jasne tło strony) —
	 * na części motywów WordPress kończy to się kursorem "pod" partyturą, czyli niewidocznym.
	 * Dla pewności podbijamy z-index ręcznie za każdym razem, gdy kursor staje się widoczny.
	 */
	function boostCursorVisibility( player ) {
		try {
			if ( player.osmd.cursor && player.osmd.cursor.cursorElement ) {
				player.osmd.cursor.cursorElement.style.zIndex = '5';
			}
		} catch ( e ) {
			// kursor opcjonalny — błąd tutaj nie powinien przerywać odtwarzania dźwięku.
		}
	}

	function pausePlayback( player, playBtn ) {
		if ( ! player.isPlaying ) {
			return;
		}
		var ac = player.audioCtx;
		var elapsedQuarters = player.playStartQuarters + ( ac.currentTime - player.playStartAudioTime ) * ( currentBpm( player ) / 60 );

		player.isPlaying = false;
		player.isPaused  = true;
		// Pauza w trakcie odliczania — zostajemy w miejscu startu.
		player.playStartQuarters = Math.max( 0, player.playStartQuarters, elapsedQuarters );

		if ( player.schedulerTimer ) {
			clearTimeout( player.schedulerTimer );
			player.schedulerTimer = null;
		}
		stopAllInstruments( player );
		stopSilentKeepAlive( player );
		if ( player.audioEl ) {
			try {
				player.audioEl.pause();
			} catch ( e ) {
				// ignorowane — podkład opcjonalny.
			}
		}

		setPlayLabel( playBtn, false );
	}

	function stopPlayback( player, playBtn, progressBar ) {
		stopSilentKeepAlive( player );
		player.isPlaying = false;
		player.isPaused  = false;
		player.playStartQuarters = 0;
		player.scheduleIndex = 0;
		player.cursorCallsMade = 0;

		if ( player.schedulerTimer ) {
			clearTimeout( player.schedulerTimer );
			player.schedulerTimer = null;
		}
		stopAllInstruments( player );
		if ( player.audioEl ) {
			try {
				player.audioEl.pause();
				player.audioEl.currentTime = 0;
			} catch ( e ) {
				// ignorowane — podkład opcjonalny.
			}
		}
		try {
			player.osmd.cursor.reset();
		} catch ( e ) {
			// ignorowane — kursor opcjonalny.
		}

		setPlayLabel( playBtn, false );
		if ( progressBar ) {
			progressBar.style.width = '0%';
		}
	}

	function currentBpm( player ) {
		return player.baseBpm * player.tempoMultiplier;
	}

	/**
	 * Zmienia tempo NUT (harmonogramu odtwarzania). Celowo NIE dotyka tempa podkładu
	 * instrumentalnego — patrz rebaseBackingTempo niżej i applyAudioPlaybackRate, które używa
	 * osobnego backingTrack.tempoMultiplier. Dzięki temu można np. przećwiczyć nuty wolniej,
	 * zostawiając nagrany podkład w oryginalnym tempie (albo odwrotnie).
	 */
	function rebaseTempo( player, multiplier ) {
		if ( player.isPlaying ) {
			var ac = player.audioCtx;
			var elapsedQuarters = player.playStartQuarters + ( ac.currentTime - player.playStartAudioTime ) * ( currentBpm( player ) / 60 );
			player.playStartQuarters = elapsedQuarters;
			player.playStartAudioTime = ac.currentTime + 0.1;
		}
		player.tempoMultiplier = multiplier;
	}

	/** Zmienia tempo PODKŁADU, niezależnie od tempa nut — patrz komentarz przy rebaseTempo. */
	function rebaseBackingTempo( player, multiplier ) {
		player.backingTrack.tempoMultiplier = multiplier;
		applyAudioPlaybackRate( player );
	}

	/**
	 * Spina suwak tempa (range) z polem do jego ręcznego wpisania (number) — dwukierunkowo:
	 * przesunięcie suwaka aktualizuje pole liczbowe, a wpisanie liczby aktualizuje suwak. Używane
	 * niezależnie dla tempa nut i tempa podkładu (patrz rebaseTempo/rebaseBackingTempo) — rangeEl
	 * i numberEl to zawsze para z TEGO SAMEGO suwaka, nie mieszamy nut z podkładem.
	 *
	 * Automatycznie wyliczony zakres suwaka (min/max ustawiane po wczytaniu utworu, na podstawie
	 * tempa z pliku nut) to tylko SUGESTIA, nie twardy limit — jeśli dyrygentka ręcznie wpisze
	 * wartość poza nim (np. bardzo wolne tempo do nauki nut), zakres suwaka się rozszerza, żeby
	 * wpisana wartość się w nim zmieściła, zamiast ją obcinać.
	 */
	function setupTempoControl( rangeEl, numberEl, getBaseBpm, onChange ) {
		if ( ! rangeEl ) {
			return;
		}

		function widenRangeIfNeeded( bpm ) {
			var min = parseInt( rangeEl.min, 10 );
			var max = parseInt( rangeEl.max, 10 );
			if ( ! isNaN( min ) && bpm < min ) {
				rangeEl.min = bpm;
			}
			if ( ! isNaN( max ) && bpm > max ) {
				rangeEl.max = bpm;
			}
		}

		rangeEl.addEventListener( 'input', function () {
			var bpm = parseInt( rangeEl.value, 10 );
			if ( isNaN( bpm ) || bpm <= 0 ) {
				bpm = Math.round( getBaseBpm() );
			}
			if ( numberEl ) {
				numberEl.value = bpm;
			}
			onChange( bpm );
		} );

		if ( ! numberEl ) {
			return;
		}

		// "input" — na bieżąco, podczas pisania: nie wymuszamy jeszcze granic/domyślnej wartości,
		// żeby nie "wyrywać" użytkowniczce wpisywanej liczby spod kursora (np. przy kasowaniu
		// cyfry, gdy pole jest chwilowo puste albo "0").
		numberEl.addEventListener( 'input', function () {
			var bpm = parseInt( numberEl.value, 10 );
			if ( isNaN( bpm ) || bpm <= 0 ) {
				return;
			}
			widenRangeIfNeeded( bpm );
			rangeEl.value = bpm;
			onChange( bpm );
		} );

		// "change" (Enter / utrata fokusu) — porządkuje wyświetlaną wartość, gdyby pole zostało
		// puste albo z nieprawidłową liczbą po zakończeniu wpisywania.
		numberEl.addEventListener( 'change', function () {
			var bpm = parseInt( numberEl.value, 10 );
			if ( isNaN( bpm ) || bpm <= 0 ) {
				bpm = Math.round( getBaseBpm() );
			}
			widenRangeIfNeeded( bpm );
			numberEl.value = bpm;
			rangeEl.value = bpm;
			onChange( bpm );
		} );
	}

	function schedulerTick( player, playBtn, progressBar ) {
		if ( ! player.isPlaying ) {
			return;
		}

		var ac  = player.audioCtx;
		var bpm = currentBpm( player );
		var nowQuarters = player.playStartQuarters + ( ac.currentTime - player.playStartAudioTime ) * ( bpm / 60 );
		var horizonQuarters = nowQuarters + LOOKAHEAD_SECONDS * ( bpm / 60 );

		while ( player.scheduleIndex < player.flatNotes.length && player.flatNotes[ player.scheduleIndex ].start <= horizonQuarters ) {
			var note = player.flatNotes[ player.scheduleIndex ];
			var gain = computeGain( player, note.key );

			// Każdy głos gra swoim własnym, wybranym w mikserze brzmieniem (patrz voiceStates[key].instrument) —
			// jeśli akurat się jeszcze wczytuje (np. tuż po zmianie w mikserze), ta konkretna nuta po prostu
			// milknie, zamiast zablokować resztę odtwarzania.
			var voiceState = player.voiceStates[ note.key ];
			var instrument = player.instrumentCache[ ( voiceState && voiceState.instrument ) || DEFAULT_VOICE_TIMBRE ];

			if ( gain > 0 && instrument ) {
				var when = player.playStartAudioTime + ( note.start - player.playStartQuarters ) * ( 60 / bpm );
				// 0.96 zamiast wcześniejszego 0.92 — odrobinę mniejsza przerwa między nutami,
				// bliżej płynnie śpiewanej frazy niż wyraźnie odseparowanych, "wystukanych" dźwięków.
				var durSec = Math.max( 0.05, note.dur * ( 60 / bpm ) * 0.96 );
				if ( when >= ac.currentTime ) {
					instrument.play( note.midi, when, { duration: durSec, gain: gain } );
				}
			}
			player.scheduleIndex++;
		}

		scheduleClicks( player, horizonQuarters, bpm );
		ensureCursorLoop( player );

		if ( progressBar && player.schedule.totalQuarters > 0 ) {
			var pct = Math.min( 100, Math.max( 0, ( nowQuarters / player.schedule.totalQuarters ) * 100 ) );
			progressBar.style.width = pct + '%';
		}

		if ( player.schedule.totalQuarters > 0 && nowQuarters >= player.schedule.totalQuarters + 1 ) {
			stopPlayback( player, playBtn, progressBar );
			return;
		}

		player.schedulerTimer = setTimeout( function () {
			schedulerTick( player, playBtn, progressBar );
		}, SCHEDULER_TICK_MS );
	}

	/* -----------------------------------------------------------------
	 * Synchronizacja kursora na partyturze (best-effort — publiczne API kursora OSMD)
	 * --------------------------------------------------------------- */

	function safeRealValue( timestamp ) {
		if ( ! timestamp ) {
			return null;
		}
		if ( 'number' === typeof timestamp.RealValue ) {
			return timestamp.RealValue;
		}
		if ( 'number' === typeof timestamp.realValue ) {
			return timestamp.realValue;
		}
		try {
			if ( 'function' === typeof timestamp.RealValue ) {
				return timestamp.RealValue();
			}
		} catch ( e ) {
			return null;
		}
		return null;
	}

	/**
	 * Przechodzi przez wszystkie kroki kursora OSMD (raz, po wyrenderowaniu partytury) i dla
	 * każdego zapamiętuje zarówno moment w utworze (w ćwierćnutach), jak i pozycję na ekranie
	 * (na potrzeby kliknięcia w nuty — patrz findNearestStepTime). Kursor musi być na chwilę
	 * widoczny, inaczej getBoundingClientRect() zwróci same zera.
	 */
	function buildCursorSteps( osmd ) {
		var steps = [];
		var positions = [];
		try {
			var cursor = osmd.cursor;
			if ( ! cursor ) {
				return { steps: steps, positions: positions };
			}
			// WAŻNE: NIE wolno tu wywoływać cursor.init() bez argumentów. OSMD sam poprawnie
			// inicjalizuje kursor wewnątrz render() (przez wewnętrzne enableOrDisableCursors()),
			// z właściwymi referencjami do "managera" i grafiki partytury. Ręczne wywołanie
			// cursor.init() bez tych argumentów nadpisuje je na undefined i po cichu psuje
			// kursor na resztę życia odtwarzacza (to był faktyczny powód, dla którego śledzenie
			// nut nie działało — błąd trafiał tylko do console.warn poniżej, niewidoczny na stronie).
			var wasHidden = ( false !== cursor.hidden );
			cursor.show();
			cursor.reset();

			var guard = 0;
			var prevRv = null;

			while ( guard < CURSOR_STEP_GUARD ) {
				var rv = safeRealValue( cursor.iterator && cursor.iterator.currentTimeStamp );
				if ( null === rv ) {
					break;
				}
				if ( null !== prevRv && rv === prevRv && guard > 0 ) {
					break;
				}
				steps.push( rv * 4 );
				positions.push( getCursorRect( cursor ) );
				prevRv = rv;

				if ( cursor.iterator && cursor.iterator.EndReached ) {
					break;
				}
				cursor.next();
				guard++;
			}
			cursor.reset();
			if ( wasHidden ) {
				cursor.hide();
			}
		} catch ( e ) {
			console.warn( 'Chór — Repertuar: synchronizacja kursora nut niedostępna w tej wersji OSMD.', e );
			return { steps: [], positions: [] };
		}
		return { steps: steps, positions: positions };
	}

	/**
	 * Pozycja kursora zapisana we współrzędnych CAŁEGO DOKUMENTU (nie viewportu) — dodajemy
	 * bieżące przewinięcie strony do wyniku getBoundingClientRect(). To kluczowe: pozycje są
	 * wyliczane raz (przy wczytaniu partytury), ale użytkownik prawie na pewno przewinie stronę,
	 * zanim kliknie w nuty — współrzędne względem viewportu zapisane wcześniej byłyby wtedy już
	 * nieaktualne. Kliknięcie (patrz scoreEl 'click') jest przeliczane do tego samego układu
	 * współrzędnych, więc porównanie działa niezależnie od tego, ile strona została przewinięta.
	 */
	function getCursorRect( cursor ) {
		if ( ! cursor.cursorElement || 'function' !== typeof cursor.cursorElement.getBoundingClientRect ) {
			return null;
		}
		var r = cursor.cursorElement.getBoundingClientRect();
		if ( ! r.width && ! r.height ) {
			return null;
		}
		return {
			top: r.top + window.scrollY,
			bottom: r.bottom + window.scrollY,
			left: r.left + window.scrollX,
			width: r.width || 1
		};
	}

	/**
	 * Znajduje krok kursora najbliższy kliknięciu (evt.clientX/clientY). Najpierw wymaga
	 * "trafienia" w odpowiednią linię/system partytury (po pionie, z małym marginesem —
	 * partytura może zawijać się do kilku linii), a wśród trafień w tę linię wybiera
	 * najbliższy poziomo. Zwraca moment w utworze (w ćwierćnutach) albo null.
	 */
	function findNearestStepTime( cursorSteps, positions, clickX, clickY ) {
		var best = null;
		var bestScore = Infinity;
		for ( var i = 0; i < positions.length; i++ ) {
			var p = positions[ i ];
			if ( ! p ) {
				continue;
			}
			// Najpierw linijka (system) najbliższa w pionie — kliknięcie w wysoką nutę nad
			// pięciolinią albo w tekst pod nią też trafia w SWOJĄ linijkę (wcześniej poza
			// marginesem 6 px wybierany był najbliższy w poziomie krok z dowolnej linijki).
			var vDist = clickY < p.top ? p.top - clickY : ( clickY > p.bottom ? clickY - p.bottom : 0 );
			var xDist = Math.abs( ( p.left + p.width / 2 ) - clickX );
			var score = Math.round( vDist ) * 100000 + Math.min( xDist, 99999 );
			if ( score < bestScore ) {
				bestScore = score;
				best = cursorSteps[ i ];
			}
		}
		return best;
	}

	/**
	 * Wyszukuje binarnie pierwszy indeks w posortowanej liście nut (flatNotes), od którego
	 * zaczynają się nuty o starcie >= targetQuarters — czyli punkt, od którego harmonogram
	 * odtwarzania ma zacząć planować dźwięk po przewinięciu.
	 */
	/** Lewy górny róg partytury we współrzędnych dokumentu. */
	function scoreOrigin( scoreEl ) {
		if ( ! scoreEl ) {
			return null;
		}
		var r = scoreEl.getBoundingClientRect();
		return { top: r.top + window.scrollY, left: r.left + window.scrollX };
	}

	function findScheduleIndex( notes, targetQuarters ) {
		var lo = 0;
		var hi = notes.length;
		while ( lo < hi ) {
			var mid = ( lo + hi ) >> 1;
			if ( notes[ mid ].start < targetQuarters ) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	/**
	 * Ustawia kursor na partyturze na krok odpowiadający targetQuarters — pozycji w WYKONANIU
	 * utworu (uwzględniającym powtórzenia; patrz seekToQuarters/schedulerTick), stąd
	 * przeliczenie przez mapPerformedToRaw na odpowiadającą pozycję "papierową" w zapisie,
	 * po której faktycznie porusza się kursor OSMD. Zawsze pełny reset + odtworzenie kroków od
	 * początku — to jedyny publicznie dostępny, niezawodny sposób "przeskoczenia" kursora OSMD
	 * w dowolne miejsce (także wstecz, np. przy przewinięciu paska postępu przed powtórzeniem).
	 */
	function repositionCursor( player, targetQuarters ) {
		if ( ! player.cursorSteps || ! player.cursorSteps.length ) {
			return;
		}
		try {
			var rawQuarters = mapPerformedToRaw( player.schedule && player.schedule.quartersMap, targetQuarters );
			var idx = findRawStepIndex( player.cursorSteps, rawQuarters );
			player.osmd.cursor.reset();
			for ( var s = 0; s < idx; s++ ) {
				player.osmd.cursor.next();
			}
			player.osmd.cursor.show();
			boostCursorVisibility( player );
			player.cursorCallsMade = idx;
		} catch ( e ) {
			// kursor opcjonalny — błąd tutaj nie powinien przerywać przewijania dźwięku.
		}
	}

	/**
	 * Przewinięcie odtwarzania do wskazanego momentu (w ćwierćnutach) — używane zarówno przy
	 * przeciąganiu paska postępu, jak i kliknięciu w nuty. Działa zarówno w trakcie
	 * odtwarzania (płynnie kontynuuje od nowego miejsca), jak i w pauzie/przed startem
	 * (zapamiętuje miejsce, od którego zacznie kolejne odtworzenie).
	 */
	function seekToQuarters( player, targetQuarters, playBtn, progressBar ) {
		if ( ! player.schedule ) {
			return;
		}
		var total = player.schedule.totalQuarters || 0;
		targetQuarters = Math.max( 0, Math.min( targetQuarters, total ) );

		var wasPlaying = player.isPlaying;

		if ( player.schedulerTimer ) {
			clearTimeout( player.schedulerTimer );
			player.schedulerTimer = null;
		}
		stopAllInstruments( player );

		player.playStartQuarters = targetQuarters;
		player.scheduleIndex = player.flatNotes ? findScheduleIndex( player.flatNotes, targetQuarters ) : 0;
		player.clickIndex = findScheduleIndex( player.schedule.clicks || [], targetQuarters );
		// Kolejne kliknięcie „Odtwórz” ma wznowić od tego miejsca, a nie zacząć od początku.
		player.isPaused = true;

		repositionCursor( player, targetQuarters );

		if ( progressBar && total > 0 ) {
			var pct = Math.min( 100, Math.max( 0, ( targetQuarters / total ) * 100 ) );
			progressBar.style.width = pct + '%';
		}

		if ( player.audioEl ) {
			syncAudioToQuarters( player, targetQuarters );
			if ( wasPlaying ) {
				var audioSeekPlayPromise = player.audioEl.play();
				if ( audioSeekPlayPromise && audioSeekPlayPromise.catch ) {
					audioSeekPlayPromise.catch( function () {} );
				}
			} else {
				try {
					player.audioEl.pause();
				} catch ( e ) {
					// ignorowane — podkład opcjonalny.
				}
			}
		}

		if ( wasPlaying && player.audioCtx ) {
			player.playStartAudioTime = player.audioCtx.currentTime + 0.1;
			player.isPlaying = true;
			schedulerTick( player, playBtn, progressBar );
		} else {
			player.isPlaying = false;
		}
	}

	/**
	 * Przesuwa kursor OSMD do kroku odpowiadającego surowej (papierowej) pozycji rawQuarters.
	 * W zwykłym przypadku (odtwarzanie posuwa się naprzód bez powtórzenia) to tani, znany już
	 * wcześniej sposób "doskakiwania" kursor.next() krok po kroku. Gdy jednak docelowy krok jest
	 * WCZEŚNIEJSZY niż aktualny (powtórzenie/wolta/D.C./D.S. cofnęły wykonanie do wcześniejszego
	 * miejsca w partyturze), kursor OSMD nie ma publicznego API "cofnij o krok" ani "przeskocz do
	 * indeksu" — jedyny niezawodny sposób to reset i odtworzenie kroków od nowa. Zwraca true,
	 * jeśli kursor faktycznie się przesunął.
	 */
	function moveCursorToRawQuarters( player, rawQuarters ) {
		var idx = findRawStepIndex( player.cursorSteps, rawQuarters );
		if ( idx === player.cursorCallsMade ) {
			return false;
		}
		if ( idx > player.cursorCallsMade ) {
			while ( player.cursorCallsMade < idx ) {
				player.osmd.cursor.next();
				player.cursorCallsMade++;
			}
		} else {
			player.osmd.cursor.reset();
			for ( var s = 0; s < idx; s++ ) {
				player.osmd.cursor.next();
			}
			player.osmd.cursor.show();
			boostCursorVisibility( player );
			player.cursorCallsMade = idx;
		}
		return true;
	}

	/**
	 * Moment utworu (w ćwierćnutach), który właśnie SŁYCHAĆ — z poprawką na opóźnienie wyjścia
	 * audio (słuchawki Bluetooth potrafią dodać 0,2 s i więcej). Do podświetlenia w nutach.
	 */
	function audibleQuarters( player ) {
		var ac = player.audioCtx;
		var bpm = currentBpm( player );
		var latency = 0;
		if ( ac ) {
			latency = ( 'number' === typeof ac.outputLatency && ac.outputLatency > 0 ) ? ac.outputLatency : ( ac.baseLatency || 0 );
		}
		// Wyprzedzenie podświetlenia (od 1.15.3): oko potrzebuje chwili, żeby zobaczyć nutę przed
		// zaśpiewaniem, a ekran i słuchawki dokładają własne opóźnienia, których przeglądarka nie
		// zawsze podaje. Domyślnie 0,12 s, do ustawienia suwakiem „Podświetlenie”.
		var lead = ( 'number' === typeof player.highlightLeadMs ? player.highlightLeadMs : DEFAULT_LEAD_MS ) / 1000;
		var q = player.playStartQuarters + ( ac.currentTime - latency + lead - player.playStartAudioTime ) * ( bpm / 60 );
		return Math.max( player.playStartQuarters, q );
	}

	/**
	 * Kursor przesuwany w rytmie odświeżania ekranu (requestAnimationFrame), a nie co takt
	 * harmonogramu dźwięku (120 ms) — wcześniej podświetlenie spóźniało się względem dźwięku
	 * nawet o 0,1 s, nierówno od nuty do nuty.
	 */
	function ensureCursorLoop( player ) {
		if ( player.cursorRaf || 'function' !== typeof window.requestAnimationFrame ) {
			if ( 'function' !== typeof window.requestAnimationFrame && player.isPlaying ) {
				advanceCursor( player, audibleQuarters( player ) );
			}
			return;
		}
		player.cursorRaf = window.requestAnimationFrame( function frame() {
			player.cursorRaf = null;
			if ( ! player.isPlaying || ! player.audioCtx ) {
				return;
			}
			advanceCursor( player, audibleQuarters( player ) );
			player.cursorRaf = window.requestAnimationFrame( frame );
		} );
	}

	function advanceCursor( player, nowQuarters ) {
		if ( ! player.cursorSteps || ! player.cursorSteps.length ) {
			return;
		}
		try {
			// nowQuarters to pozycja w WYKONANIU utworu (uwzględniającym powtórzenia) — przeliczamy
			// na pozycję "papierową" w zapisie, po której faktycznie porusza się kursor OSMD (patrz
			// komentarz przy mapPerformedToRaw). Dzięki temu kursor poprawnie "cofa się" wizualnie
			// przy powtórzeniu/wolcie/D.C./D.S., zamiast po prostu dobiec do końca wydrukowanych
			// taktów i zamrzeć, podczas gdy dźwięk gra dalej powtórzony fragment.
			var rawQuarters = mapPerformedToRaw( player.schedule && player.schedule.quartersMap, nowQuarters );
			var moved = moveCursorToRawQuarters( player, rawQuarters );
			if ( moved ) {
				maybeAutoScrollToCursor( player );
			}
		} catch ( e ) {
			player.cursorSteps = [];
		}
	}

	/**
	 * Własne (nie poleganie wyłącznie na wewnętrznym "followCursor" OSMD) przewijanie strony
	 * tak, żeby aktualnie odtwarzany takt zawsze był widoczny pod górnym, "zablokowanym"
	 * paskiem sterowania (.cnr-player__controls). Włącza się tylko wtedy, gdy kursor
	 * faktycznie wyszedł poza widoczny obszar, i ma krótki "cooldown", żeby nie przerywać
	 * animacji przewijania co każdy krok nuty.
	 */
	/**
	 * Dolna krawędź elementów strony (spoza odtwarzacza) przyklejonych do góry ekranu: pasek
	 * administratora WordPressa, przyklejony nagłówek motywu itp. Sprawdzane „sondą” w kilku
	 * punktach u góry ekranu.
	 */
	function fixedHeaderBottom( player, fresh ) {
		// Wynik pamiętany przez 0,5 s — sonda (elementFromPoint) wymusza przeliczenie układu
		// strony; wołana przy każdym kroku kursora i przy każdej klatce przewijania potrafiła na
		// telefonie spowalniać przesuwanie podświetlenia.
		var now = Date.now();
		if ( ! fresh && player.headerCache && now - player.headerCache.time < 500 ) {
			return player.headerCache.value;
		}
		var bound = 0;
		try {
			var x = Math.round( window.innerWidth / 2 );
			var limit = Math.min( 240, window.innerHeight / 3 );
			for ( var y = 1; y < limit; y += 16 ) {
				var el = document.elementFromPoint( x, y );
				var fixedFound = false;
				while ( el && el !== document.body && el !== document.documentElement ) {
					if ( player.container.contains( el ) ) {
						break;
					}
					var pos = window.getComputedStyle( el ).position;
					if ( 'fixed' === pos || 'sticky' === pos ) {
						var r = el.getBoundingClientRect();
						if ( r.top <= 1 && r.bottom > 0 && r.bottom < window.innerHeight / 2 ) {
							bound = Math.max( bound, r.bottom );
							fixedFound = true;
							y = Math.max( y, Math.floor( r.bottom ) ); // od razu pod ten nagłówek
						}
						break;
					}
					el = el.parentElement;
				}
				if ( ! fixedFound ) {
					break; // pierwsze miejsce bez przyklejonego elementu — dalej to już treść strony
				}
			}
		} catch ( e ) {
			// tylko udogodnienie
		}
		bound = Math.round( bound );
		player.headerCache = { time: now, value: bound };
		return bound;
	}


	/**
	 * Przyklejony pasek odtwarzacza ustawiamy tuż POD przyklejonym nagłówkiem motywu / paskiem
	 * administratora (w CSS było na sztywno 0 / 32 / 46 px — przy motywie z przyklejonym
	 * nagłówkiem pasek odtwarzacza i góra nut chowały się pod nim).
	 */
	function setupStickyOffset( player ) {
		var controlsEl = player.container.querySelector( '.cnr-player__controls' );
		if ( ! controlsEl ) {
			return;
		}
		var pending = false;
		function update() {
			pending = false;
			var bound = fixedHeaderBottom( player );
			var current = parseFloat( controlsEl.style.top ) || 0;
			if ( bound > 0 && Math.abs( bound - current ) >= 1 ) {
				controlsEl.style.top = bound + 'px';
			} else if ( 0 === bound && controlsEl.style.top ) {
				controlsEl.style.top = '';
			}
		}
		function schedule() {
			if ( ! pending ) {
				pending = true;
				( window.requestAnimationFrame || setTimeout )( update );
			}
		}
		window.addEventListener( 'scroll', schedule, { passive: true } );
		window.addEventListener( 'resize', function () {
			player.headerCache = null;
			schedule();
		} );
		update();
	}

	/** Dolna krawędź przyklejonego paska odtwarzacza (po przewinięciu w dół) — granica widocznych nut. */
	function stickyTopBound( player ) {
		var controlsEl = player.container.querySelector( '.cnr-player__controls' );
		if ( ! controlsEl ) {
			return fixedHeaderBottom( player );
		}
		var cr = controlsEl.getBoundingClientRect();
		var cs = window.getComputedStyle( controlsEl );
		if ( 'sticky' === cs.position || 'fixed' === cs.position ) {
			return Math.max( ( parseFloat( cs.top ) || 0 ) + cr.height, fixedHeaderBottom( player ) );
		}
		return Math.max( 0, cr.bottom, fixedHeaderBottom( player ) );
	}

	function maybeAutoScrollToCursor( player ) {
		try {
			var cursor = player.osmd.cursor;
			if ( ! cursor || ! cursor.cursorElement ) {
				return;
			}
			var now = Date.now();
			if ( player.scrollCooldownUntil && now < player.scrollCooldownUntil ) {
				return;
			}
			var rect = cursor.cursorElement.getBoundingClientRect();
			if ( ! rect.width && ! rect.height ) {
				return;
			}

			var topBound = stickyTopBound( player );
			var visibleHeight = Math.max( 120, window.innerHeight - topBound );
			// Zapas nad górną pięciolinią systemu: kursor obejmuje tylko pięciolinie, a nad nimi
			// bywają nuty na liniach dodanych, oznaczenia tempa/dynamiki, numery taktów, akordy.
			var headroom = Math.min( 90, Math.max( 24, ( visibleHeight - rect.height ) / 3 ) );
			var fits = rect.height + headroom + 24 <= visibleHeight;

			// System widoczny w całości (z zapasem nad nim) — nic nie robimy. Dla systemu wyższego
			// niż ekran wystarczy, że jego góra jest widoczna tuż pod paskiem odtwarzacza.
			var topOk = rect.top >= topBound + Math.min( headroom, 24 );
			if ( topOk && ( fits ? rect.bottom <= window.innerHeight - 16 : rect.top <= topBound + visibleHeight * 0.4 ) ) {
				return;
			}

			// Cel: górna pięciolinia systemu tuż pod paskiem odtwarzacza (z zapasem „headroom”),
			// a nie „na środku ekranu” — wtedy cały system mieści się pod paskiem i widać też
			// kolejną linijkę nut.
			var targetY = Math.max( 0, window.scrollY + rect.top - topBound - ( fits ? headroom : Math.max( 24, Math.min( 48, visibleHeight * 0.15 ) ) ) );

			// Pomiń, jeśli nowy cel przewinięcia jest praktycznie taki sam jak ostatni — zapobiega
			// drobnym, powtarzającym się doprzewijaniom o kilka pikseli.
			if ( null !== player.lastScrollTargetY && Math.abs( targetY - player.lastScrollTargetY ) < 8 && Math.abs( window.scrollY - targetY ) < 8 ) {
				return;
			}

			window.scrollTo( { top: targetY, behavior: 'smooth' } );
			player.lastScrollTargetY = targetY;
			// "Cooldown" na czas płynnego przewijania — żeby nie przerywać animacji.
			player.scrollCooldownUntil = now + 700;
		} catch ( e ) {
			// automatyczne przewijanie jest tylko udogodnieniem — błąd nie powinien przerywać odtwarzania.
		}
	}

	// Wewnętrzne funkcje dostępne do automatycznych testów (bez wpływu na działanie strony).
	window.CNR = window.CNR || {};
	window.CNR.playerInternals = {
		parseMusicXmlForPlayback: parseMusicXmlForPlayback,
		defaultPresetFor: defaultPresetFor,
		initialSoundSource: initialSoundSource,
		readDefaults: readDefaults,
		parseMeasureMarkers: parseMeasureMarkers,
		combineMeasureMarkers: combineMeasureMarkers,
		expandMeasureOrder: expandMeasureOrder
	};
} )();
