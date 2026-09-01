import LiveBoard from "./LiveBoard";

export default function LivePage() {
  return (
    <div className="flex flex-col flex-1 items-center font-sans">
      <main className="flex w-full max-w-3xl flex-col gap-6 py-16 px-6">
        <h1 className="text-2xl font-semibold text-foreground">
          Live Board
        </h1>
        <LiveBoard />
      </main>
    </div>
  );
}
