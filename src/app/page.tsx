"use client";

import { useState } from "react";
import QATab from "@/components/tabs/QATab";
import WeeklyTab from "@/components/tabs/WeeklyTab";
import InsightsTab from "@/components/tabs/InsightsTab";
import styles from "./page.module.css";

const TABS = [
  { id: "ask", label: "Ask" },
  { id: "weekly", label: "Weekly updates" },
  { id: "insights", label: "Over time" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("ask");

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}>
            <span className={styles.logoText}>Reddit Insight Agent</span>
            <span className={styles.subs}>r/starbucks · r/starbucksbaristas</span>
            <span className={styles.readonly}>read-only</span>
          </div>
          <nav className={styles.nav}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`${styles.navBtn} ${
                  activeTab === tab.id ? styles.navBtnActive : ""
                }`}
                onClick={() => setActiveTab(tab.id)}
                aria-current={activeTab === tab.id ? "page" : undefined}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className={styles.main}>
        {/* Tabs stay mounted so scroll position and answers survive switching. */}
        <div hidden={activeTab !== "ask"}>
          <QATab />
        </div>
        <div hidden={activeTab !== "weekly"}>
          <WeeklyTab active={activeTab === "weekly"} />
        </div>
        <div hidden={activeTab !== "insights"}>
          <InsightsTab active={activeTab === "insights"} />
        </div>
      </main>
    </div>
  );
}
