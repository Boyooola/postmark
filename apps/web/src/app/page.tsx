import Link from "next/link";

export default function Home() {
  return (
    <main className="landing">
      <div className="landing-card">
        <p className="eyebrow">Prototype · Milestone 1</p>
        <h1>Postmark</h1>
        <p className="lede">
          Fly a little mail plane over a real Earth: real mountains, coastlines, lakes and rivers, and the
          world&apos;s landmarks rising out of the globe.
        </p>
        <Link className="play" href="/play">
          Take off
        </Link>
        <p className="fineprint">Best on a desktop browser with a keyboard or gamepad.</p>
      </div>
    </main>
  );
}
