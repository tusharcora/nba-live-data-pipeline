import LiveBoard from "./LiveBoard";

export default function LivePage() {
  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-6 py-16 px-6">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Live Board
        </h1>
        <LiveBoard />
      </main>
    </div>
  );
}
