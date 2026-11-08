/**
 * Odtwarzacz plików SoundFont 2 (.sf2) w przeglądarce — Web Audio, bez zewnętrznych bibliotek
 * (od 1.13.0). Pozwala odtwarzać głosy chóralne brzmieniami z własnego pliku .sf2 zamiast
 * wbudowanych brzmień General MIDI (soundfont-player) — patrz player.js (loadInstrument).
 *
 * Instrument zwracany przez SoundFontBank.createInstrument() ma CELOWO ten sam interfejs co
 * instrument soundfont-player — play( midiNote, when, { duration, gain } ) oraz stop() — więc
 * odtwarzacz planuje nuty tak samo, niezależnie od źródła dźwięku.
 *
 * Obsługiwane: SoundFont 2.0x z nieskompresowanymi próbkami 16-bit (zdecydowana większość
 * plików .sf2). NIEobsługiwane: .sf3 (próbki Ogg Vorbis) — odrzucane z czytelnym komunikatem.
 * Uwzględniane generatory: zakresy klawiszy/dynamiki, próbka i jej pętla, strojenie, głośność,
 * panorama, obwiednia głośności. Modulatory, filtry, LFO i efekty są pomijane.
 */
( function ( global ) {
	'use strict';

	// Numery generatorów wg specyfikacji SoundFont 2.04, rozdz. 8.1.2.
	var GEN = {
		startAddrsOffset: 0,
		endAddrsOffset: 1,
		startloopAddrsOffset: 2,
		endloopAddrsOffset: 3,
		startAddrsCoarseOffset: 4,
		endAddrsCoarseOffset: 12,
		pan: 17,
		delayVolEnv: 33,
		attackVolEnv: 34,
		holdVolEnv: 35,
		decayVolEnv: 36,
		sustainVolEnv: 37,
		releaseVolEnv: 38,
		instrument: 41,
		keyRange: 43,
		velRange: 44,
		startloopAddrsCoarseOffset: 45,
		initialAttenuation: 48,
		endloopAddrsCoarseOffset: 50,
		coarseTune: 51,
		fineTune: 52,
		sampleID: 53,
		sampleModes: 54,
		scaleTuning: 56,
		overridingRootKey: 58
	};

	var RANGE_GENS = [ GEN.keyRange, GEN.velRange ];

	// Generatory, które na poziomie PRESETU są dodawane do wartości z instrumentu (spec. 9.4).
	// Adresy próbki, sampleModes i overridingRootKey są dozwolone WYŁĄCZNIE w instrumencie.
	var PRESET_ADDITIVE_GENS = [
		GEN.pan, GEN.delayVolEnv, GEN.attackVolEnv, GEN.holdVolEnv, GEN.decayVolEnv,
		GEN.sustainVolEnv, GEN.releaseVolEnv, GEN.initialAttenuation, GEN.coarseTune,
		GEN.fineTune, GEN.scaleTuning
	];

	var TIMECENTS_INSTANT = -12000; // domyślna wartość obwiedni: "natychmiast" (~1 ms)
	var MIN_RELEASE_SECONDS = 0.01; // żeby urwanie nuty nie dawało trzasku
	// Tak jak sprzętowe syntezatory EMU i FluidSynth — surowe initialAttenuation z pliku
	// tłumione o 0,4, inaczej większość SoundFontów brzmi wyraźnie ciszej niż w innych programach.
	var ATTENUATION_FACTOR = 0.4;
	// Zapas głośności całego SoundFontu (-12 dB). Pomiar względem FluidSynth (wzorcowego
	// odtwarzacza .sf2) na tym samym pliku i tych samych nutach pokazał, że bez tego grało
	// ~20 dB głośniej: pojedyncza nuta dochodziła do 60% pełnej skali, a akord z pedałem
	// przekraczał ją o 30–85% — stąd przestery przy własnych brzmieniach (0.18.0).
	var OUTPUT_GAIN = 0.25;
	// Limit jednocześnie brzmiących głosów jednego instrumentu. SoundFonty organowe potrafią mieć
	// kilka warstw stereo na KAŻDĄ nutę, a przy legato głosy się zachodzą — bez limitu słabszy
	// komputer nie nadąża z liczeniem dźwięku, co słychać jako trzaski niezależnie od głośności.
	var MAX_VOICES = 96;
	var VOICE_STEAL_FADE = 0.03;

	// Nazwy presetów organowych — getDefaultPresetKey() (player.js dobiera własne domyślne dla głosów).
	var ORGAN_NAME_PATTERN = /organ|orgel|orgue|organo|organy|principal|pryncypa|diapason|prinzipal|pleno|flute|flet|bourdon|gedackt/i;

	// ------------------------------------------------------------------------------------------
	// Parser pliku .sf2
	// ------------------------------------------------------------------------------------------

	function fourCC( view, offset ) {
		return String.fromCharCode(
			view.getUint8( offset ),
			view.getUint8( offset + 1 ),
			view.getUint8( offset + 2 ),
			view.getUint8( offset + 3 )
		);
	}

	function readName( view, offset, length ) {
		var out = '';
		for ( var i = 0; i < length; i++ ) {
			var c = view.getUint8( offset + i );
			if ( 0 === c ) {
				break;
			}
			out += String.fromCharCode( c );
		}
		return out.replace( /\s+$/, '' );
	}

	/** Czyta rekordy generatorów [from, to) jako obiekt { numerGeneratora: wartość }. */
	function readGenerators( view, chunk, from, to ) {
		var gens = {};
		for ( var i = from; i < to; i++ ) {
			var off  = chunk.offset + i * 4;
			if ( off + 4 > chunk.offset + chunk.size ) {
				break;
			}
			var oper = view.getUint16( off, true );
			if ( -1 !== RANGE_GENS.indexOf( oper ) ) {
				gens[ oper ] = [ view.getUint8( off + 2 ), view.getUint8( off + 3 ) ];
			} else if ( GEN.instrument === oper || GEN.sampleID === oper ) {
				gens[ oper ] = view.getUint16( off + 2, true );
			} else {
				gens[ oper ] = view.getInt16( off + 2, true );
			}
		}
		return gens;
	}

	/**
	 * Wspólny dla presetów i instrumentów odczyt "stref" (zones): rekordy nagłówków (phdr/inst)
	 * wskazują zakres rekordów bag, a te — zakres rekordów generatorów. Pierwsza strefa BEZ
	 * generatora końcowego (instrument/sampleID) to strefa globalna — jej generatory są
	 * domyślnymi wartościami dla pozostałych stref tego samego presetu/instrumentu.
	 */
	function readZones( view, bagChunk, genChunk, bagFrom, bagTo, terminalGen ) {
		var zones  = [];
		var global = null;
		var bagCount = Math.floor( bagChunk.size / 4 );
		for ( var b = bagFrom; b < bagTo && b + 1 < bagCount; b++ ) {
			var genFrom = view.getUint16( bagChunk.offset + b * 4, true );
			var genTo   = view.getUint16( bagChunk.offset + ( b + 1 ) * 4, true );
			var gens    = readGenerators( view, genChunk, genFrom, genTo );
			if ( undefined === gens[ terminalGen ] ) {
				if ( 0 === zones.length && null === global ) {
					global = gens;
				}
				continue;
			}
			var merged = {};
			var k;
			if ( global ) {
				for ( k in global ) {
					if ( Object.prototype.hasOwnProperty.call( global, k ) ) {
						merged[ k ] = global[ k ];
					}
				}
			}
			for ( k in gens ) {
				if ( Object.prototype.hasOwnProperty.call( gens, k ) ) {
					merged[ k ] = gens[ k ];
				}
			}
			zones.push( merged );
		}
		return zones;
	}

	/**
	 * Parsuje cały plik SoundFont. Rzuca Error z komunikatem po polsku, gdy plik nie jest
	 * poprawnym, obsługiwanym SoundFontem.
	 *
	 * @param {ArrayBuffer} buffer
	 * @return {{ presets: Array, instruments: Array, samples: Array, sampleData: {offset, size}, view: DataView }}
	 */
	function parseSoundFont( buffer ) {
		var view = new DataView( buffer );
		if ( view.byteLength < 12 || 'RIFF' !== fourCC( view, 0 ) || 'sfbk' !== fourCC( view, 8 ) ) {
			throw new Error( 'To nie jest plik SoundFont (.sf2).' );
		}

		var chunks = {};
		var off = 12;
		while ( off + 8 <= view.byteLength ) {
			var id   = fourCC( view, off );
			var size = view.getUint32( off + 4, true );
			if ( 'LIST' === id && off + 12 <= view.byteLength ) {
				var listType = fourCC( view, off + 8 );
				var sub = off + 12;
				var end = Math.min( off + 8 + size, view.byteLength );
				while ( sub + 8 <= end ) {
					var subId   = fourCC( view, sub );
					var subSize = view.getUint32( sub + 4, true );
					chunks[ listType + '/' + subId ] = { offset: sub + 8, size: Math.min( subSize, end - sub - 8 ) };
					sub += 8 + subSize + ( subSize & 1 );
				}
			}
			off += 8 + size + ( size & 1 );
		}

		if ( chunks[ 'INFO/ifil' ] && chunks[ 'INFO/ifil' ].size >= 2 && view.getUint16( chunks[ 'INFO/ifil' ].offset, true ) >= 3 ) {
			throw new Error( 'Pliki .sf3 (skompresowane) nie są obsługiwane — użyj wersji .sf2 tego SoundFontu.' );
		}

		var required = [ 'sdta/smpl', 'pdta/phdr', 'pdta/pbag', 'pdta/pgen', 'pdta/inst', 'pdta/ibag', 'pdta/igen', 'pdta/shdr' ];
		for ( var r = 0; r < required.length; r++ ) {
			if ( ! chunks[ required[ r ] ] ) {
				throw new Error( 'Uszkodzony plik SoundFont — brak sekcji ' + required[ r ] + '.' );
			}
		}

		var smpl = chunks[ 'sdta/smpl' ];
		var phdr = chunks[ 'pdta/phdr' ];
		var inst = chunks[ 'pdta/inst' ];
		var shdr = chunks[ 'pdta/shdr' ];

		// --- Próbki (ostatni rekord "EOS" to terminator) ---
		var samples = [];
		var sampleCount = Math.floor( shdr.size / 46 ) - 1;
		for ( var s = 0; s < sampleCount; s++ ) {
			var so = shdr.offset + s * 46;
			var sampleType = view.getUint16( so + 44, true );
			samples.push( {
				name: readName( view, so, 20 ),
				start: view.getUint32( so + 20, true ),
				end: view.getUint32( so + 24, true ),
				loopStart: view.getUint32( so + 28, true ),
				loopEnd: view.getUint32( so + 32, true ),
				sampleRate: view.getUint32( so + 36, true ) || 44100,
				originalPitch: view.getUint8( so + 40 ),
				pitchCorrection: view.getInt8( so + 41 ),
				sampleType: sampleType,
				compressed: !! ( sampleType & 0x10 ),
				rom: !! ( sampleType & 0x8000 )
			} );
		}
		if ( samples.some( function ( smp ) { return smp.compressed; } ) ) {
			throw new Error( 'Pliki .sf3 (skompresowane) nie są obsługiwane — użyj wersji .sf2 tego SoundFontu.' );
		}

		// --- Instrumenty (ostatni rekord "EOI" to terminator) ---
		var instruments = [];
		var instCount = Math.floor( inst.size / 22 ) - 1;
		for ( var i = 0; i < instCount; i++ ) {
			var io = inst.offset + i * 22;
			instruments.push( {
				name: readName( view, io, 20 ),
				zones: readZones(
					view, chunks[ 'pdta/ibag' ], chunks[ 'pdta/igen' ],
					view.getUint16( io + 20, true ),
					view.getUint16( io + 22 + 20, true ),
					GEN.sampleID
				)
			} );
		}

		// --- Presety (ostatni rekord "EOP" to terminator) ---
		var presets = [];
		var presetCount = Math.floor( phdr.size / 38 ) - 1;
		for ( var p = 0; p < presetCount; p++ ) {
			var po = phdr.offset + p * 38;
			presets.push( {
				name: readName( view, po, 20 ),
				program: view.getUint16( po + 20, true ),
				bank: view.getUint16( po + 22, true ),
				zones: readZones(
					view, chunks[ 'pdta/pbag' ], chunks[ 'pdta/pgen' ],
					view.getUint16( po + 24, true ),
					view.getUint16( po + 38 + 24, true ),
					GEN.instrument
				)
			} );
		}

		return {
			presets: presets,
			instruments: instruments,
			samples: samples,
			sampleData: smpl,
			view: view
		};
	}

	// ------------------------------------------------------------------------------------------
	// Wyznaczanie "regionów" (konkretna próbka + parametry) dla danej nuty
	// ------------------------------------------------------------------------------------------

	function inRange( range, value ) {
		return ! range || ( value >= range[ 0 ] && value <= range[ 1 ] );
	}

	function timecentsToSeconds( tc ) {
		if ( undefined === tc || null === tc || tc <= TIMECENTS_INSTANT ) {
			return 0;
		}
		return Math.pow( 2, tc / 1200 );
	}

	/** Łączy generatory strefy instrumentu i strefy presetu w gotowe parametry odtworzenia. */
	function buildRegion( sample, instGens, presetGens ) {
		function inst( gen, def ) {
			return undefined !== instGens[ gen ] ? instGens[ gen ] : def;
		}
		function total( gen, def ) {
			var v = inst( gen, def );
			if ( -1 !== PRESET_ADDITIVE_GENS.indexOf( gen ) && undefined !== presetGens[ gen ] ) {
				v += presetGens[ gen ];
			}
			return v;
		}

		var start     = sample.start + inst( GEN.startAddrsOffset, 0 ) + inst( GEN.startAddrsCoarseOffset, 0 ) * 32768;
		var end       = sample.end + inst( GEN.endAddrsOffset, 0 ) + inst( GEN.endAddrsCoarseOffset, 0 ) * 32768;
		var loopStart = sample.loopStart + inst( GEN.startloopAddrsOffset, 0 ) + inst( GEN.startloopAddrsCoarseOffset, 0 ) * 32768;
		var loopEnd   = sample.loopEnd + inst( GEN.endloopAddrsOffset, 0 ) + inst( GEN.endloopAddrsCoarseOffset, 0 ) * 32768;
		if ( end <= start ) {
			end = sample.end;
		}

		var rootKey = inst( GEN.overridingRootKey, -1 );
		if ( rootKey < 0 || rootKey > 127 ) {
			rootKey = sample.originalPitch <= 127 ? sample.originalPitch : 60;
		}

		var modes = inst( GEN.sampleModes, 0 ) & 3;
		var loop  = ( 1 === modes || 3 === modes ) && loopEnd > loopStart && loopStart >= start && loopEnd <= end;

		var attenuationCb = Math.max( 0, total( GEN.initialAttenuation, 0 ) ) * ATTENUATION_FACTOR;
		var sustainCb     = Math.max( 0, Math.min( 1440, total( GEN.sustainVolEnv, 0 ) ) );

		return {
			sample: sample,
			start: start,
			end: end,
			loop: loop,
			// Pętla względem POCZĄTKU bufora (który zaczyna się w "start"), w próbkach.
			loopStart: loopStart - start,
			loopEnd: loopEnd - start,
			rootKey: rootKey,
			coarseTune: total( GEN.coarseTune, 0 ),
			fineTune: total( GEN.fineTune, 0 ) + sample.pitchCorrection,
			scaleTuning: total( GEN.scaleTuning, 100 ),
			pan: Math.max( -1, Math.min( 1, total( GEN.pan, 0 ) / 500 ) ),
			gain: Math.pow( 10, -attenuationCb / 200 ),
			env: {
				delay: timecentsToSeconds( total( GEN.delayVolEnv, TIMECENTS_INSTANT ) ),
				attack: timecentsToSeconds( total( GEN.attackVolEnv, TIMECENTS_INSTANT ) ),
				hold: timecentsToSeconds( total( GEN.holdVolEnv, TIMECENTS_INSTANT ) ),
				decay: timecentsToSeconds( total( GEN.decayVolEnv, TIMECENTS_INSTANT ) ),
				sustain: Math.pow( 10, -sustainCb / 200 ),
				release: Math.max( MIN_RELEASE_SECONDS, timecentsToSeconds( total( GEN.releaseVolEnv, TIMECENTS_INSTANT ) ) )
			}
		};
	}

	/** Wszystkie regiony (warstwy — np. lewa+prawa próbka stereo) grające daną nutę w presecie. */
	function findRegions( sf, preset, key, velocity ) {
		var regions = [];
		preset.zones.forEach( function ( pz ) {
			if ( ! inRange( pz[ GEN.keyRange ], key ) || ! inRange( pz[ GEN.velRange ], velocity ) ) {
				return;
			}
			var instrument = sf.instruments[ pz[ GEN.instrument ] ];
			if ( ! instrument ) {
				return;
			}
			instrument.zones.forEach( function ( iz ) {
				if ( ! inRange( iz[ GEN.keyRange ], key ) || ! inRange( iz[ GEN.velRange ], velocity ) ) {
					return;
				}
				var sample = sf.samples[ iz[ GEN.sampleID ] ];
				if ( ! sample || sample.rom ) {
					return;
				}
				regions.push( buildRegion( sample, iz, pz ) );
			} );
		} );
		return regions;
	}

	/** Mnożnik prędkości odtwarzania próbki, żeby zabrzmiała nuta midiNote. */
	function computePlaybackRate( region, midiNote ) {
		var cents = ( midiNote - region.rootKey ) * region.scaleTuning + region.coarseTune * 100 + region.fineTune;
		return Math.pow( 2, cents / 1200 );
	}

	/**
	 * Planuje obwiednię głośności jednego głosu na AudioParam. Czas końca nuty jest znany z góry
	 * (OrganPlayer planuje nuty z wyprzedzeniem i od razu podaje ich długość), więc poziom w
	 * chwili puszczenia klawisza liczymy analitycznie — nie trzeba polegać na
	 * cancelAndHoldAtTime(), którego nie wszystkie przeglądarki obsługują.
	 *
	 * @return {number} czas (w zegarze audioCtx), po którym głos jest całkowicie wyciszony.
	 */
	function scheduleEnvelope( param, when, noteOff, env, peak ) {
		var tAttackStart = when + env.delay;
		var tPeak        = tAttackStart + env.attack;
		var tHoldEnd     = tPeak + env.hold;
		var tDecayEnd    = tHoldEnd + env.decay;
		var sustainLevel = peak * env.sustain;

		function levelAt( t ) {
			if ( t <= tAttackStart ) {
				return 0;
			}
			if ( t < tPeak ) {
				return peak * ( t - tAttackStart ) / ( tPeak - tAttackStart );
			}
			if ( t <= tHoldEnd ) {
				return peak;
			}
			if ( t < tDecayEnd ) {
				return peak + ( sustainLevel - peak ) * ( t - tHoldEnd ) / ( tDecayEnd - tHoldEnd );
			}
			return sustainLevel;
		}

		param.setValueAtTime( 0, when );
		if ( noteOff > tAttackStart ) {
			if ( env.attack > 0 ) {
				param.setValueAtTime( 0, tAttackStart );
				param.linearRampToValueAtTime( noteOff < tPeak ? levelAt( noteOff ) : peak, Math.min( tPeak, noteOff ) );
			} else {
				param.setValueAtTime( peak, tAttackStart );
			}
			if ( noteOff > tHoldEnd && sustainLevel !== peak ) {
				param.setValueAtTime( peak, tHoldEnd );
				param.linearRampToValueAtTime( levelAt( Math.min( noteOff, tDecayEnd ) ), Math.min( noteOff, tDecayEnd ) );
			}
		}
		param.setValueAtTime( levelAt( noteOff ), noteOff );
		param.linearRampToValueAtTime( 0, noteOff + env.release );
		return noteOff + env.release;
	}

	// ------------------------------------------------------------------------------------------
	// Bank (wczytany plik) i instrument (jeden wybrany preset)
	// ------------------------------------------------------------------------------------------

	function SoundFontBank( arrayBuffer ) {
		this.sf       = parseSoundFont( arrayBuffer );
		this._buffers = {};
	}

	/** Lista presetów do wyboru, posortowana po banku i numerze programu. */
	SoundFontBank.prototype.getPresets = function () {
		return this.sf.presets
			.map( function ( p ) {
				return { key: p.bank + ':' + p.program, name: p.name, bank: p.bank, program: p.program };
			} )
			.sort( function ( a, b ) {
				return ( a.bank - b.bank ) || ( a.program - b.program );
			} );
	};

	SoundFontBank.prototype.findPreset = function ( key ) {
		var parts = String( key || '' ).split( ':' );
		var bank = parseInt( parts[ 0 ], 10 );
		var program = parseInt( parts[ 1 ], 10 );
		for ( var i = 0; i < this.sf.presets.length; i++ ) {
			if ( this.sf.presets[ i ].bank === bank && this.sf.presets[ i ].program === program ) {
				return this.sf.presets[ i ];
			}
		}
		return null;
	};

	/**
	 * Domyślny preset: pierwszy, którego nazwa wygląda na organy; inaczej GM "Church Organ"
	 * (bank 0, program 19), jeśli istnieje; inaczej pierwszy w pliku.
	 */
	SoundFontBank.prototype.getDefaultPresetKey = function () {
		var list = this.getPresets();
		if ( ! list.length ) {
			return '';
		}
		for ( var i = 0; i < list.length; i++ ) {
			if ( ORGAN_NAME_PATTERN.test( list[ i ].name ) ) {
				return list[ i ].key;
			}
		}
		for ( var j = 0; j < list.length; j++ ) {
			if ( 0 === list[ j ].bank && 19 === list[ j ].program ) {
				return list[ j ].key;
			}
		}
		return list[ 0 ].key;
	};

	/** AudioBuffer dla fragmentu [start, end) próbek — tworzony leniwie i cache'owany. */
	SoundFontBank.prototype._getBuffer = function ( audioCtx, region ) {
		var cacheKey = region.start + ':' + region.end + ':' + region.sample.sampleRate;
		if ( this._buffers[ cacheKey ] ) {
			return this._buffers[ cacheKey ];
		}
		var view       = this.sf.view;
		var dataStart  = this.sf.sampleData.offset;
		var maxSamples = Math.floor( this.sf.sampleData.size / 2 );
		var start      = Math.max( 0, Math.min( region.start, maxSamples ) );
		var end        = Math.max( start + 1, Math.min( region.end, maxSamples ) );
		var length     = end - start;
		var buffer     = audioCtx.createBuffer( 1, length, region.sample.sampleRate );
		var channel    = buffer.getChannelData( 0 );
		for ( var i = 0; i < length; i++ ) {
			channel[ i ] = view.getInt16( dataStart + ( start + i ) * 2, true ) / 32768;
		}
		this._buffers[ cacheKey ] = buffer;
		return buffer;
	};

	/**
	 * Tworzy instrument o interfejsie zgodnym z soundfont-player.
	 *
	 * @param {AudioContext} audioCtx
	 * @param {string} presetKey "bank:program" (patrz getPresets())
	 * @param {{ destination: AudioNode }} options
	 */
	SoundFontBank.prototype.createInstrument = function ( audioCtx, presetKey, options ) {
		var preset = this.findPreset( presetKey ) || this.findPreset( this.getDefaultPresetKey() );
		if ( ! preset ) {
			throw new Error( 'SoundFont nie zawiera żadnego brzmienia (presetu).' );
		}
		return new SoundFontInstrument( this, audioCtx, preset, ( options && options.destination ) || audioCtx.destination );
	};

	function SoundFontInstrument( bank, audioCtx, preset, destination ) {
		this.bank        = bank;
		this.audioCtx    = audioCtx;
		this.preset      = preset;
		this.destination = destination;
		this._voices     = [];
	}

	SoundFontInstrument.prototype.play = function ( midiNote, when, options ) {
		var self     = this;
		var ctx      = this.audioCtx;
		options      = options || {};
		var gain     = Math.max( 0, Math.min( 1, undefined !== options.gain ? options.gain : 1 ) );
		var velocity = Math.max( 1, Math.min( 127, Math.round( gain * 127 ) ) );
		var duration = Math.max( 0.01, options.duration || 1 );
		var start    = Math.max( ctx.currentTime, when || 0 );
		var noteOff  = start + duration;

		var regions = findRegions( this.bank.sf, this.preset, midiNote, velocity );
		this._stealVoices( this._voices.length + regions.length - MAX_VOICES );
		regions.forEach( function ( region ) {
			var src = ctx.createBufferSource();
			src.buffer = self.bank._getBuffer( ctx, region );
			src.playbackRate.value = computePlaybackRate( region, midiNote );
			if ( region.loop ) {
				src.loop      = true;
				src.loopStart = region.loopStart / region.sample.sampleRate;
				src.loopEnd   = region.loopEnd / region.sample.sampleRate;
			}

			var amp = ctx.createGain();
			var silentAt = scheduleEnvelope( amp.gain, start, noteOff, region.env, gain * region.gain * OUTPUT_GAIN );
			src.connect( amp );

			if ( region.pan && ctx.createStereoPanner ) {
				var panner = ctx.createStereoPanner();
				panner.pan.value = region.pan;
				amp.connect( panner );
				panner.connect( self.destination );
			} else {
				amp.connect( self.destination );
			}

			var voice = { src: src, amp: amp, start: start };
			self._voices.push( voice );
			src.onended = function () {
				var idx = self._voices.indexOf( voice );
				if ( -1 !== idx ) {
					self._voices.splice( idx, 1 );
				}
				try {
					amp.disconnect();
				} catch ( e ) {}
			};
			src.start( start );
			src.stop( silentAt + 0.05 );
		} );
	};

	/**
	 * Zwalnia $count najstarszych głosów (krótkie wyciszenie zamiast urwania, żeby nie trzaskało)
	 * — patrz MAX_VOICES.
	 */
	SoundFontInstrument.prototype._stealVoices = function ( count ) {
		if ( count <= 0 ) {
			return;
		}
		var now = this.audioCtx.currentTime;
		var stolen = this._voices.splice( 0, count );
		stolen.forEach( function ( v ) {
			try {
				if ( v.amp.gain.cancelScheduledValues ) {
					v.amp.gain.cancelScheduledValues( now );
					v.amp.gain.setValueAtTime( v.amp.gain.value, now );
					v.amp.gain.linearRampToValueAtTime( 0, now + VOICE_STEAL_FADE );
				}
				v.src.stop( now + VOICE_STEAL_FADE + 0.01 );
			} catch ( e ) {}
		} );
	};

	/** Natychmiast ucisza wszystkie brzmiące i zaplanowane głosy tego instrumentu. */
	SoundFontInstrument.prototype.stop = function () {
		var voices = this._voices.slice();
		this._voices = [];
		voices.forEach( function ( v ) {
			try {
				v.src.stop( 0 );
			} catch ( e ) {}
			try {
				v.amp.disconnect();
			} catch ( e ) {}
		} );
	};

	// ------------------------------------------------------------------------------------------
	// Pobieranie pliku (z postępem i pamięcią przeglądarki)
	// ------------------------------------------------------------------------------------------

	var CACHE_NAME   = 'cnr-soundfont-v1';
	var loadPromises = {};

	function readResponseWithProgress( response, onProgress ) {
		var total = parseInt( response.headers.get( 'Content-Length' ) || '0', 10 ) || 0;
		if ( ! response.body || ! response.body.getReader ) {
			return response.arrayBuffer();
		}
		var reader = response.body.getReader();
		var parts  = [];
		var loaded = 0;
		function pump() {
			return reader.read().then( function ( result ) {
				if ( result.done ) {
					var out = new Uint8Array( loaded );
					var pos = 0;
					parts.forEach( function ( part ) {
						out.set( part, pos );
						pos += part.length;
					} );
					return out.buffer;
				}
				parts.push( result.value );
				loaded += result.value.length;
				if ( onProgress ) {
					onProgress( loaded, total );
				}
				return pump();
			} );
		}
		return pump();
	}

	function openCache() {
		try {
			if ( global.caches && global.caches.open ) {
				return global.caches.open( CACHE_NAME ).catch( function () { return null; } );
			}
		} catch ( e ) {}
		return Promise.resolve( null );
	}

	/**
	 * Pobiera i parsuje SoundFont spod adresu url. Ten sam adres jest pobierany tylko raz na
	 * stronę (współdzielony Promise), a — gdy przeglądarka na to pozwala (HTTPS) — plik jest też
	 * zapamiętywany w pamięci przeglądarki (Cache Storage), żeby kolejne otwarcia panelu
	 * utworów nie pobierały znów kilkudziesięciu/kilkuset MB.
	 *
	 * @param {string} url
	 * @param {function(number, number)=} onProgress (pobrane bajty, całość — 0 gdy nieznana)
	 * @return {Promise<SoundFontBank>}
	 */
	function loadSoundFont( url, onProgress ) {
		if ( ! url ) {
			return Promise.reject( new Error( 'Brak adresu pliku SoundFont.' ) );
		}
		if ( loadPromises[ url ] ) {
			return loadPromises[ url ];
		}
		var promise = openCache().then( function ( cache ) {
			var cached = cache ? cache.match( url ).catch( function () { return null; } ) : Promise.resolve( null );
			return cached.then( function ( hit ) {
				if ( hit ) {
					return hit.arrayBuffer();
				}
				return fetch( url ).then( function ( response ) {
					if ( ! response.ok ) {
						throw new Error( 'Nie udało się pobrać pliku SoundFont (HTTP ' + response.status + ').' );
					}
					return readResponseWithProgress( response, onProgress );
				} ).then( function ( buffer ) {
					// Najpierw sprawdzamy, czy to w ogóle poprawny SoundFont — nie zapamiętujemy śmieci.
					var bank = new SoundFontBank( buffer );
					if ( cache ) {
						try {
							cache.put( url, new Response( buffer ) ).catch( function () {} );
						} catch ( e ) {}
					}
					return bank;
				} );
			} ).then( function ( result ) {
				return result instanceof SoundFontBank ? result : new SoundFontBank( result );
			} );
		} );
		loadPromises[ url ] = promise;
		promise.catch( function () {
			delete loadPromises[ url ]; // nieudana próba nie blokuje ponownej
		} );
		return promise;
	}

	var api = {
		GEN: GEN,
		parseSoundFont: parseSoundFont,
		buildRegion: buildRegion,
		findRegions: findRegions,
		computePlaybackRate: computePlaybackRate,
		timecentsToSeconds: timecentsToSeconds,
		scheduleEnvelope: scheduleEnvelope,
		SoundFontBank: SoundFontBank,
		loadSoundFont: loadSoundFont,
		OUTPUT_GAIN: OUTPUT_GAIN,
		MAX_VOICES: MAX_VOICES
	};

	if ( 'undefined' !== typeof module && module.exports ) {
		module.exports = api;
	} else {
		global.CNR = global.CNR || {};
		global.CNR.SoundFont = api;
	}
}( 'undefined' !== typeof window ? window : global ) );
