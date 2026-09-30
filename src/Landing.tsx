import { useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Film,
  Heart,
  Headphones,
  Link2,
  LockKeyhole,
  Maximize2,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { Brand, Modal } from './components';
import { samples } from './lib';

export default function Landing({
  onCreate,
  onJoin,
}: {
  onCreate: () => void;
  onJoin: () => void;
}) {
  const [category, setCategory] = useState('Movie nights');
  const [faq, setFaq] = useState<number | null>(null);
  const [demo, setDemo] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [demoError, setDemoError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const categories = [
    {
      name: 'Movie nights',
      icon: Film,
      title: 'Make any night a movie night.',
      text: 'The opening scene. The plot twist. The shared silence. Be there for all of it, together.',
      image: 'cinema',
      tag: 'PASS THE POPCORN',
      color: 'orange',
    },
    {
      name: 'Music sessions',
      icon: Music2,
      title: 'Your favorite songs. Your favorite people.',
      text: 'Trade discoveries, build a queue, and let the soundtrack to your friendship play on.',
      image: 'music',
      tag: 'ON THE SAME WAVELENGTH',
      color: 'purple',
    },
    {
      name: 'Just hanging out',
      icon: Video,
      title: 'No plans is a pretty good plan.',
      text: 'Put something on. Catch up. Let a quick hello turn into one of those nights.',
      image: 'adventure',
      tag: 'GOOD COMPANY, ANYWHERE',
      color: 'green',
    },
  ];
  const selected = categories.find((c) => c.name === category)!;
  const faqs = [
    [
      'Do we need to create an account?',
      'Nope. Just choose a display name, create a room, and share the link. Your friends can join with a name and your invitation. That’s it.',
    ],
    [
      'What can we watch or listen to?',
      'Add a direct link to a video or audio file, or an HLS live stream. MP4, WebM, MP3, and other formats supported by your browser work. YouTube links work too, as long as the owner allows the video to play on other websites. You can also share a video or song from your device (up to 100 MB); it’s deleted when the room closes. Or play a file straight from your device without uploading it: everyone chooses their own copy, and it stays in sync. Subscription streaming services aren’t supported.',
    ],
    [
      'How does watching together work?',
      'The room shares a playback clock. Play, pause, seek, and speed changes are sent to everyone, and the player checks for drift regularly. A friend joining midway catches up to the current moment. Network conditions can still cause small delays.',
    ],
    [
      'Is my room private?',
      'Rooms have no public listing. Only people with your code or invitation link can find yours. The host can lock the room, remove someone, and decide who can control playback.',
    ],
    [
      'Can I use it on my phone?',
      'Absolutely. The room adapts to your phone, with separate tabs for chat, people, and the queue. Voice and camera access need a secure connection and your browser’s permission. Rooms support up to eight people.',
    ],
  ];
  function toggleDemo() {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setDemoError(true));
    else el.pause();
  }
  return (
    <div className="landing">
      <header className="site-header">
        <div className="nav-wrap">
          <Brand onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />
          <nav aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#made-for-you">Made for your moments</a>
            <a href="#questions">FAQs</a>
          </nav>
          <div className="nav-actions">
            <button className="nav-join" onClick={onJoin}>
              Join a room <ArrowUpRight size={16} />
            </button>
            <button className="button small primary" onClick={onCreate}>
              Create a room <Plus size={16} />
            </button>
          </div>
        </div>
      </header>
      <main>
        <section className="hero content-width">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="live-dot" /> A LITTLE CLOSER, WHEREVER YOU ARE
            </div>
            <h1>
              Different places.
              <br />
              Same moment<span className="orange-text">.</span>
            </h1>
            <p>
              Your favorite movies, music, and people.
              <br className="desktop-break" /> All together in one little room.
            </p>
            <div className="hero-buttons">
              <button className="button primary" onClick={onCreate}>
                Create a room <ArrowUpRight size={19} />
              </button>
              <button className="button secondary" onClick={onJoin}>
                <Link2 size={18} />
                Join a room
              </button>
            </div>
            <div className="hero-reassurance">
              <span>
                <Check size={14} />
                No sign-up
              </span>
              <span>
                <Check size={14} />
                Free to hang out
              </span>
              <span>
                <Check size={14} />
                Just good company
              </span>
            </div>
            <div className="hero-note">
              <span className="hand-drawn-arrow">↳</span>Distance shouldn’t get the best seat.
            </div>
          </div>
          <div className="hero-visual">
            <div className="visual-orbit orbit-one" />
            <div className="visual-orbit orbit-two" />
            <div className="floating-note top-note">
              <span className="tiny-icon">
                <Zap size={15} fill="currentColor" />
              </span>
              Same scene. Same second.
            </div>
            <div className="preview-room">
              <div className="preview-header">
                <span className="preview-logo">
                  <span className="live-dot" />
                  Friday, with the favorites
                </span>
                <span>
                  <Users size={13} />4 <MoreHorizontal size={19} />
                </span>
              </div>
              <button
                className="preview-screen"
                onClick={() => setDemo(true)}
                aria-label="Play a preview of Sintel"
              >
                <img
                  src="/images/mountains.jpg"
                  alt="A dramatic mountain peak rising into sunlit clouds"
                />
                <span className="preview-shade" />
                <span className="preview-live">
                  <span className="live-dot" /> IN SYNC
                </span>
                <span className="preview-play">
                  <Play size={23} fill="currentColor" />
                </span>
                <span className="preview-caption">
                  <span>A little escape</span>
                  <small>A big world. Better together.</small>
                </span>
                <span className="preview-timeline">
                  <i />
                  <span />
                </span>
                <span className="preview-control-row">
                  <Play size={12} fill="currentColor" />
                  <small>
                    02:34 <span>/ 14:48</span>
                  </small>
                  <Volume2 size={13} />
                  <Maximize2 size={13} />
                </span>
              </button>
              <div className="preview-people">
                <div className="preview-person">
                  <span className="demo-face peach">
                    A<span>✦</span>
                  </span>
                  <small>
                    You <Mic size={10} />
                  </small>
                </div>
                <div className="preview-person">
                  <span className="demo-face sage">
                    R<span>☺</span>
                  </span>
                  <small>
                    Rahul <Mic size={10} />
                  </small>
                </div>
                <div className="preview-person">
                  <span className="demo-face lavender">
                    D<span>✿</span>
                  </span>
                  <small>
                    Dibya <Mic size={10} />
                  </small>
                </div>
                <div className="preview-person">
                  <span className="demo-face blue">
                    M<span>☻</span>
                  </span>
                  <small>
                    Maya <Mic size={10} />
                  </small>
                </div>
                <span
                  className="preview-person-add"
                  onClick={onCreate}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onCreate();
                  }}
                  aria-label="Create a room to invite friends"
                >
                  <Plus size={18} />
                </span>
              </div>
              <div className="preview-footer">
                <span>
                  <ShieldCheck size={12} /> A private little corner of the internet
                </span>
                <span className="preview-label">ROOM PREVIEW</span>
              </div>
            </div>
            <div className="floating-note reaction-note">
              <span>🍿</span>
              <div>
                “Okay, everyone ready?”<small>The best part is who’s watching.</small>
              </div>
              <Heart size={19} fill="#e76b42" color="#e76b42" />
            </div>
            <span className="decor-star">✳</span>
          </div>
        </section>
        <section className="feature-ribbon">
          <div className="content-width ribbon-inner">
            <span>
              <Zap size={18} />
              Perfectly in the moment
            </span>
            <i />
            <span>
              <MessageCircle size={18} />
              Chat, laugh, react
            </span>
            <i />
            <span>
              <Video size={18} />
              See your people
            </span>
            <i />
            <span>
              <LockKeyhole size={18} />
              Your room. Your rules.
            </span>
          </div>
        </section>
        <section className="how-section content-width" id="how-it-works">
          <div className="section-heading">
            <div>
              <span className="eyebrow muted-eyebrow">LESS SETUP. MORE TOGETHER.</span>
              <h2>Three steps. A whole lot closer.</h2>
            </div>
            <span className="section-aside">
              No downloads. No “what’s your password?”
              <br />
              Just send the link and settle in.
            </span>
          </div>
          <div className="steps-grid">
            <article className="step-card">
              <div className="step-top">
                <span className="step-icon peach">
                  <Plus size={24} />
                </span>
                <span className="step-number">01</span>
              </div>
              <h3>Make room for good company.</h3>
              <p>
                Give yourself a name and open your room. It’s your space, from the very first click.
              </p>
              <button className="step-link" onClick={onCreate}>
                Create your room <ArrowRight size={16} />
              </button>
            </article>
            <article className="step-card">
              <div className="step-top">
                <span className="step-icon sage">
                  <Link2 size={24} />
                </span>
                <span className="step-number">02</span>
              </div>
              <h3>Send a little “come over.”</h3>
              <p>Share your room link or code. Your friends can hop in from wherever they are.</p>
              <span className="step-decoration">
                One link. All your favorite people. <Heart size={13} />
              </span>
            </article>
            <article className="step-card">
              <div className="step-top">
                <span className="step-icon lavender">
                  <Play size={23} />
                </span>
                <span className="step-number">03</span>
              </div>
              <h3>Press play. Feel closer.</h3>
              <p>Watch in sync, turn your cameras on, and let the good times do their thing.</p>
              <span className="step-decoration">
                <span className="live-dot" /> You’re right here, together.
              </span>
            </article>
          </div>
        </section>
        <section className="moments-section content-width" id="made-for-you">
          <div className="section-heading">
            <div>
              <span className="eyebrow muted-eyebrow">IT’S NOT JUST WHAT YOU WATCH</span>
              <h2>It’s who you share it with.</h2>
            </div>
            <span className="little-spark">
              <Sparkles size={30} />
            </span>
          </div>
          <div className="moments-tabs" role="tablist" aria-label="Ways to spend time together">
            {categories.map((c) => (
              <button
                key={c.name}
                role="tab"
                aria-selected={category === c.name}
                className={category === c.name ? 'active' : ''}
                onClick={() => setCategory(c.name)}
              >
                <c.icon size={17} />
                {c.name}
              </button>
            ))}
          </div>
          <div className="moment-feature" role="tabpanel" key={category}>
            <div className="moment-copy">
              <span className="eyebrow">{selected.tag}</span>
              <h3>{selected.title}</h3>
              <p>{selected.text}</p>
              <button className="button secondary" onClick={onCreate}>
                Get everyone together <ArrowUpRight size={17} />
              </button>
              <div className="moment-tags">
                <span>
                  <MessageCircle size={13} />
                  Live chat
                </span>
                <span>
                  <Headphones size={13} />
                  Voice & video
                </span>
                <span>
                  <Radio size={13} />
                  In sync
                </span>
              </div>
            </div>
            <div className="moment-image">
              <img
                src={`/images/${selected.image}.jpg`}
                alt={
                  category === 'Movie nights'
                    ? 'A warmly lit cinema, ready for movie night'
                    : category === 'Music sessions'
                      ? 'Colorful lights above a concert crowd'
                      : 'An open green landscape under a soft evening sky'
                }
                loading="lazy"
              />
              <div className="moment-image-label">
                <span>
                  {category === 'Movie nights' ? '🍿' : category === 'Music sessions' ? '🎧' : '☀️'}
                </span>
                <div>
                  {category === 'Movie nights'
                    ? 'Your couch just got bigger.'
                    : category === 'Music sessions'
                      ? 'Good taste is better shared.'
                      : 'A little less far away.'}
                  <small>Make a moment of it.</small>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="faq-section content-width" id="questions">
          <div className="faq-intro">
            <span className="eyebrow muted-eyebrow">A FEW THINGS, BEFORE PLAY</span>
            <h2>Glad you asked.</h2>
            <p>
              Less wondering.
              <br />
              More time with your people.
            </p>
            <span className="faq-doodle">hello, together.</span>
          </div>
          <div className="faq-list">
            {faqs.map(([q, a], i) => (
              <div className={`faq-item ${faq === i ? 'open' : ''}`} key={q}>
                <button
                  onClick={() => setFaq(faq === i ? null : i)}
                  aria-expanded={faq === i}
                  aria-controls={`faq-${i}`}
                >
                  {q}
                  <ChevronDown size={18} />
                </button>
                {faq === i && <p id={`faq-${i}`}>{a}</p>}
              </div>
            ))}
          </div>
        </section>
        <section className="final-cta content-width">
          <div className="cta-spark">✳</div>
          <span className="eyebrow">THE DISTANCE CAN WAIT.</span>
          <h2>
            Your people. One room.
            <br />A really good time.
          </h2>
          <button className="button primary" onClick={onCreate}>
            Let’s get together <ArrowUpRight size={18} />
          </button>
          <p>No sign-up. No fuss. Just press play.</p>
          <span className="cta-orbit" />
        </section>
      </main>
      <footer className="site-footer content-width">
        <Brand onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />
        <span>A little closer, wherever you are.</span>
        <span className="footer-love">
          Made for the moments between us <Heart size={13} />
        </span>
      </footer>
      {demo && (
        <Modal
          title="A peek at movie night."
          subtitle="Try Sintel, an open movie by the Blender Foundation."
          onClose={() => {
            setDemo(false);
            setPlaying(false);
            setDemoError(false);
          }}
          className="demo-modal"
        >
          <video
            ref={video}
            src={samples[0].url}
            muted={muted}
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setDemoError(true)}
            poster="/images/mountains.jpg"
          />
          <div className="demo-actions">
            <button className="button secondary" onClick={toggleDemo}>
              {playing ? <Pause size={17} /> : <Play size={17} />}
              {playing ? 'Pause' : 'Play preview'}
            </button>
            <button
              className="icon-button"
              onClick={() => setMuted(!muted)}
              aria-label={muted ? 'Unmute preview' : 'Mute preview'}
            >
              {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
            <button
              className="button primary"
              onClick={() => {
                setDemo(false);
                onCreate();
              }}
            >
              Watch with friends <ArrowRight size={16} />
            </button>
          </div>
          {demoError && (
            <p className="form-error">
              This preview couldn’t load. You can still create a room and add your own media link.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
