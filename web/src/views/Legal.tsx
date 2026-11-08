const UPDATED = "8 November 2026";
const REPO = "https://github.com/Mramaran/termwork";

function Back() {
  return (
    <p className="nextstep">
      <a href="#repo">Back to the app</a>
    </p>
  );
}

export function Terms() {
  return (
    <section className="legal" aria-labelledby="terms-h">
      <h2 id="terms-h">Terms and conditions</h2>
      <p className="note">Last updated {UPDATED}</p>

      <h3>A hackathon project</h3>
      <p>
        Termwork was built for the NEAR hackathon as a demonstration. It is not a commercial product or service, is not run by a company, and is not maintained to any service level. It may change, break or be taken offline at any time without notice.
      </p>

      <h3>Testnet only</h3>
      <p>
        Everything runs on NEAR <b>testnet</b>. Testnet NEAR has no monetary value, and the payments, DAO votes and balances shown here are test transactions. Do not connect a wallet holding mainnet funds expecting it to be used, and do not send real assets to any account shown on this site.
      </p>

      <h3>No advice</h3>
      <p>
        The AI decisions on this site are advice to the agent and are shown to explain how it works. They are not financial, legal or investment advice, and they may be wrong. The fixed rules and the contract decide what is paid, and only on the demo repository.
      </p>

      <h3>Using the site</h3>
      <ul>
        <li>Analysing a repository other than the demo repository is read-only: nothing is paid and nothing is written to GitHub.</li>
        <li>Only members of the demo DAO&apos;s council can trigger payments or vote. Connecting a wallet does not give anyone else that ability.</li>
        <li>Requests are rate-limited. Do not try to get around the limits, overload the service, or use it to reach repositories or data you are not allowed to access.</li>
      </ul>

      <h3>Code and licence</h3>
      <p>
        The source code is open under the{" "}
        <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
          MIT licence
        </a>
        . As that licence says, it is provided &quot;as is&quot;, without warranty of any kind, and the authors are not liable for any claim, damages or other liability arising from its use.
      </p>

      <h3>Third-party services</h3>
      <p>
        The site relies on GitHub, the NEAR testnet RPC and explorer, NEAR AI Cloud, the Intear and MyNearWallet wallets, and Vercel hosting. Their own terms apply when you use them, and we do not control their availability.
      </p>

      <h3>Questions</h3>
      <p>
        Open an issue on the{" "}
        <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
          GitHub repository
        </a>
        .
      </p>
      <Back />
    </section>
  );
}

export function Privacy() {
  return (
    <section className="legal" aria-labelledby="privacy-h">
      <h2 id="privacy-h">Privacy policy</h2>
      <p className="note">Last updated {UPDATED}</p>

      <h3>A hackathon project</h3>
      <p>
        Termwork was built for the NEAR hackathon as a demonstration. It has no user accounts, no sign-up, no analytics, no advertising and no tracking cookies, and we do not sell or share personal data.
      </p>

      <h3>What stays in your browser</h3>
      <ul>
        <li>Your light or dark theme choice, in local storage.</li>
        <li>If you connect a wallet, the wallet connector keeps your testnet account name in your browser so the page remembers it. Disconnecting or clearing site data removes it.</li>
      </ul>

      <h3>What the server handles</h3>
      <ul>
        <li>
          <b>Repository analysis.</b> The repository name and date range you enter are sent to our server, which reads that repository&apos;s merged pull requests from GitHub. Nothing about the analysis is stored after the response is sent.
        </li>
        <li>
          <b>AI decisions.</b> For each pull request, its URL, title, author&apos;s GitHub name, size, labels, merge date and NEAR account are sent to NEAR AI Cloud, which runs the model. NEAR AI&apos;s own privacy terms apply to that request.
        </li>
        <li>
          <b>Rate limits.</b> Your IP address is held in server memory for about a minute to enforce request limits, then discarded. It is not written to disk.
        </li>
        <li>
          <b>Error logs.</b> When a request fails, the server logs the pull request URL and the error. Vercel, our host, also keeps standard request logs for a limited time under its own policy.
        </li>
        <li>
          <b>Council sign-in.</b> A council member who runs payments signs a short-lived message with their wallet. The server checks it against the chain and does not keep it.
        </li>
      </ul>

      <h3>What is public by design</h3>
      <p>
        Payments, DAO votes and the agent&apos;s work log are transactions on NEAR testnet, which anyone can read. When the agent pays a pull request on the demo repository, it adds a label and a comment to that pull request on GitHub. The NEAR account in a pull request&apos;s <code>near:</code> line is public on GitHub and, once paid, on the chain.
      </p>

      <h3>GitHub access</h3>
      <p>
        The server reads GitHub with its own access token. That token is never sent to your browser and is removed from every response. You do not give the site access to your GitHub account.
      </p>

      <h3>Questions or removal requests</h3>
      <p>
        Open an issue on the{" "}
        <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
          GitHub repository
        </a>
        . Data already written to the NEAR blockchain cannot be removed.
      </p>
      <Back />
    </section>
  );
}
