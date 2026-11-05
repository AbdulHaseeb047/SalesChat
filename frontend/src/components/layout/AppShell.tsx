'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { NavLink } from '@/lib/next-nav';
import type { FeatureKey } from '@/lib/shared';
import { BRAND, getTierFeaturePreset, type TenantTier } from '@/lib/shared';

import {
  IconBox,
  IconBrand,
  IconChart,
  IconClose,
  IconDashboard,
  IconGrid,
  IconHistory,
  IconMenu,
  IconSale,
  IconStaff,
  IconSupplier,
  IconTag,
  IconWallet,
} from '@/components/icons';
import { AccountMenu } from '@/components/layout/AccountMenu';
import { SidebarHeader } from '@/components/layout/SidebarHeader';
import { Select } from '@/components/ui/Select';
import { SyncBanner } from '@/components/layout/SyncBanner';
import { TrialBanner } from '@/components/billing/TrialBanner';
import { SettingsDialogProvider } from '@/features/settings/settings-dialog-context';
import { FEATURES, hasPlanFeature } from '@/lib/features';
import { useAuth } from '@/lib/auth';
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed';

type NavItem = {
  to: string;
  label: string;
  icon: React.FC<React.SVGProps<SVGSVGElement>>;
  feature: FeatureKey | null;
  end?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    title: 'Billing',
    items: [
      { to: '/pos/sale', label: 'Register', icon: IconSale, feature: FEATURES.BILLING_CREATE_SALE },
      // Sales history is a basic need on every plan (including Starter).
      { to: '/pos/sales', label: 'History', icon: IconHistory, feature: null },
      {
        to: '/pos/discounts',
        label: 'Discounts',
        icon: IconTag,
        feature: FEATURES.BILLING_DISCOUNT,
      },
    ],
  },
  {
    title: 'Catalog',
    items: [
      {
        to: '/pos/inventory',
        label: 'Inventory',
        icon: IconBox,
        feature: FEATURES.INVENTORY_VIEW,
        end: true,
      },
      {
        to: '/pos/categories',
        label: 'Categories',
        icon: IconGrid,
        feature: FEATURES.INVENTORY_CATEGORIES,
      },
      {
        to: '/pos/shop-parts',
        label: 'Shop Parts',
        icon: IconTag,
        feature: FEATURES.INVENTORY_SHOP_PARTS,
      },
      { to: '/pos/brands', label: 'Brands', icon: IconBrand, feature: FEATURES.INVENTORY_BRANDS },
      {
        to: '/pos/suppliers',
        label: 'Suppliers',
        icon: IconSupplier,
        feature: FEATURES.INVENTORY_SUPPLIERS,
      },
    ],
  },
  {
    title: 'Accounts',
    items: [
      { to: '/pos/customers', label: 'Udhaar', icon: IconWallet, feature: FEATURES.CUSTOMERS_VIEW },
      { to: '/pos/financial', label: 'Shop cash', icon: IconWallet, feature: FEATURES.REPORTS_VIEW },
      { to: '/pos/staff', label: 'Staff', icon: IconStaff, feature: FEATURES.USERS_MANAGE },
    ],
  },
  {
    title: 'Insights',
    items: [
      { to: '/pos/reports', label: 'Reports', icon: IconChart, feature: FEATURES.REPORTS_VIEW },
    ],
  },
];

const dashboardItem: NavItem = {
  to: '/pos',
  label: 'Dashboard',
  icon: IconDashboard,
  feature: null,
  end: true,
};

function NavItemLink({
  item,
  collapsed,
  locked,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  locked?: boolean;
  onNavigate?: () => void;
}) {
  const to = locked ? '/pos/upgrade' : item.to;

  return (
    <NavLink
      to={to}
      end={locked ? false : item.end}
      title={locked ? `${item.label} — Upgrade to unlock` : item.label}
      state={locked ? { fromFeature: item.label } : undefined}
      onClick={onNavigate}
      className={({ isActive }) =>
        `sidebar-nav-link flex min-h-[44px] cursor-pointer items-center rounded-xl py-2 text-[13px] font-semibold tracking-wide transition-all ${
          collapsed ? 'justify-center px-2' : 'gap-2 px-3'
        } ${
          !locked && isActive
            ? 'bg-sidebar-active text-white shadow-sm'
            : 'text-brand-100/95 hover:bg-sidebar-hover hover:text-white'
        } ${locked ? 'opacity-45 hover:opacity-70' : ''}`
      }
    >
      <span className="sidebar-nav-icon-wrap flex shrink-0 items-center justify-center">
        <item.icon className="sidebar-nav-icon h-4 w-4 opacity-90" />
      </span>
      {!collapsed && (
        <>
          <span className="sidebar-nav-label min-w-0 flex-1 truncate">{item.label}</span>
          {locked && (
            <span className="shrink-0 rounded-md bg-brand-500/95 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">
              Upgrade
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

type NavItemWithLock = NavItem & { locked?: boolean };

function SidebarNav({
  collapsed,
  visibleSections,
  onNavigate,
}: {
  collapsed: boolean;
  visibleSections: Array<{ title: string; items: NavItemWithLock[] }>;
  onNavigate?: () => void;
}) {
  return (
    <>
      <nav
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain py-2.5 ${
          collapsed ? 'space-y-1 px-1' : 'space-y-3.5 px-1.5'
        }`}
      >
        <NavItemLink item={dashboardItem} collapsed={collapsed} onNavigate={onNavigate} />

        {visibleSections.map((section) => (
          <div key={section.title}>
            {!collapsed && (
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-brand-200/65">
                {section.title}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavItemLink
                  key={item.to}
                  item={item}
                  collapsed={collapsed}
                  locked={Boolean(item.locked)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div
        className={`relative z-10 shrink-0 border-t border-sidebar-border ${collapsed ? 'p-1' : 'p-2'}`}
      >
        <AccountMenu placement="sidebar" collapsed={collapsed} />
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, branches, branchId, setBranchId } = useAuth();
  const { collapsed, toggle } = useSidebarCollapsed();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const assignedPlan = (user?.planEntitlement?.assignedPlan ?? user?.planEntitlement?.trialPlan) as
    TenantTier | undefined;
  const assignedKeys = new Set(assignedPlan ? getTierFeaturePreset(assignedPlan) : []);

  const visibleSections = navSections
    .map((section) => ({
      ...section,
      items: section.items
        .filter(
          (item) =>
            !item.feature || hasPlanFeature(user, item.feature) || assignedKeys.has(item.feature),
        )
        .map((item) => ({
          ...item,
          // Only lock features that are outside the shop’s assigned plan (upsell teasers).
          locked: Boolean(
            item.feature && !hasPlanFeature(user, item.feature) && !assignedKeys.has(item.feature),
          ),
        })),
    }))
    .filter((section) => section.items.length > 0);

  // Close drawer on route change (mobile).
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  return (
    <SettingsDialogProvider>
      <div className="flex h-dvh min-h-0 bg-surface-muted md:h-screen">
        {/* Desktop sidebar */}
        <aside
          className={`sidebar-shell sticky top-0 z-30 hidden h-full shrink-0 flex-col bg-sidebar font-sans antialiased text-text-inverse transition-[width] duration-200 ease-in-out md:flex ${
            collapsed ? 'w-[4.75rem]' : 'w-[15.5rem]'
          }`}
        >
          <SidebarHeader collapsed={collapsed} onToggle={toggle} />
          <SidebarNav collapsed={collapsed} visibleSections={visibleSections} />
        </aside>

        {/* Mobile drawer */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-text/45 backdrop-blur-[2px]"
              aria-label="Close menu"
              onClick={() => setMobileNavOpen(false)}
            />
            <aside className="sidebar-shell absolute inset-y-0 left-0 flex w-[min(18rem,88vw)] flex-col bg-sidebar font-sans antialiased text-text-inverse shadow-2xl">
              <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
                <div className="flex min-w-0 items-center">
                  <span className="truncate text-sm font-extrabold tracking-tight text-white">
                    SaleChat
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-brand-100 hover:bg-sidebar-hover hover:text-white"
                  aria-label="Close menu"
                >
                  <IconClose className="h-5 w-5" />
                </button>
              </div>
              <SidebarNav
                collapsed={false}
                visibleSections={visibleSections}
                onNavigate={() => setMobileNavOpen(false)}
              />
            </aside>
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-surface px-3 py-2 md:hidden">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-white text-text"
              aria-label="Open menu"
            >
              <IconMenu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-text">{BRAND.productName}</p>
            </div>
            {branches.length > 1 && (
              <Select
                className="w-[7.5rem] py-1.5 text-xs min-h-[40px]"
                value={branchId ?? ''}
                onChange={(e) => setBranchId(e.target.value)}
                options={branches.map((b) => ({
                  value: b.id,
                  label: b.name,
                }))}
              />
            )}
          </header>

          {branches.length > 1 && (
            <div className="hidden items-center justify-end gap-2 border-b border-border bg-surface px-4 py-2 md:flex lg:px-6">
              <span className="text-xs font-medium text-text-muted">Branch</span>
              <Select
                className="w-44 py-1.5 text-xs min-h-[36px]"
                value={branchId ?? ''}
                onChange={(e) => setBranchId(e.target.value)}
                options={branches.map((b) => ({
                  value: b.id,
                  label: `${b.name}${b.isDefault ? ' (default)' : ''}`,
                }))}
              />
            </div>
          )}

          <TrialBanner />
          <SyncBanner />

          <main className="flex min-h-0 flex-1 flex-col overflow-auto p-3 sm:p-4 lg:p-5">
            {children}
          </main>
        </div>
      </div>
    </SettingsDialogProvider>
  );
}
