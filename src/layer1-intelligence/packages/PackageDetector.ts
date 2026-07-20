// ═══════════════════════════════════════════════════════════════
// Package Detector — Parse and categorize npm dependencies
// ═══════════════════════════════════════════════════════════════

import { PackageInfo } from '../../shared/types/scanner.types';
import { DependencyInfo } from '../../shared/types/context.types';

/** Categorizes npm packages for context retrieval. */
const PACKAGE_CATEGORIES: Record<string, string[]> = {
  'framework': ['react', 'next', 'vue', 'angular', '@nestjs/core', 'express', 'fastify', 'koa'],
  'state-management': ['redux', '@reduxjs/toolkit', 'zustand', 'recoil', 'jotai', 'mobx', 'valtio'],
  'data-fetching': ['axios', 'swr', '@tanstack/react-query', 'react-query', 'graphql', '@apollo/client', 'got', 'node-fetch'],
  'orm-database': ['prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'sequelize', 'mongoose', 'knex'],
  'validation': ['zod', 'yup', 'joi', 'class-validator', 'class-transformer', 'superstruct', 'valibot'],
  'auth': ['next-auth', '@auth/core', 'passport', 'jsonwebtoken', 'bcrypt', 'bcryptjs', '@clerk/nextjs'],
  'testing': ['jest', 'vitest', '@testing-library/react', 'cypress', 'playwright', '@playwright/test', 'supertest'],
  'styling': ['tailwindcss', 'styled-components', '@emotion/react', '@mui/material', '@chakra-ui/react', 'sass'],
  'form': ['react-hook-form', 'formik', '@tanstack/react-form'],
  'utility': ['lodash', 'ramda', 'date-fns', 'dayjs', 'uuid', 'nanoid', 'chalk', 'debug'],
  'build-tool': ['typescript', 'esbuild', 'webpack', 'vite', 'swc', 'turbopack', 'rollup'],
};

export class PackageDetector {
  /**
   * Analyze package.json and return categorized dependencies.
   */
  analyze(packageInfo: PackageInfo): DependencyInfo[] {
    const results: DependencyInfo[] = [];

    for (const [name, version] of Object.entries(packageInfo.dependencies)) {
      results.push({
        name, version, isDevDependency: false,
        category: this.categorize(name),
      });
    }

    for (const [name, version] of Object.entries(packageInfo.devDependencies)) {
      results.push({
        name, version, isDevDependency: true,
        category: this.categorize(name),
      });
    }

    return results;
  }

  /** Get only the "important" dependencies (frameworks, ORMs, state mgmt). */
  getKeyDependencies(packageInfo: PackageInfo): DependencyInfo[] {
    return this.analyze(packageInfo).filter(d =>
      !d.isDevDependency && d.category !== 'utility' && d.category !== 'build-tool' && d.category !== 'unknown'
    );
  }

  private categorize(packageName: string): string {
    for (const [category, packages] of Object.entries(PACKAGE_CATEGORIES)) {
      if (packages.some(p => packageName === p || packageName.startsWith(p + '/'))) {
        return category;
      }
    }
    return 'unknown';
  }
}
