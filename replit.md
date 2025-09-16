# 시대영재 학원관리 SaaS 시스템

## Overview

시대영재 학원관리 SaaS는 한국 학원(개인/소규모)을 위한 포괄적인 관리 시스템입니다. 이 시스템은 학생 등록, 수업 관리, 수납 처리, 교사 배정, 그리고 일지 작성을 위한 통합 플랫폼을 제공합니다. 

시스템의 핵심 기능은 다중 테넌트 아키텍처를 기반으로 하며, 각 학원이 독립적인 데이터를 관리할 수 있습니다. 특별히 한국 교육 환경에 맞춰 형제할인, 개별 수업료 설정, 월별 수납 관리 등의 기능을 포함합니다.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript, built using Vite
- **UI Library**: Radix UI components with custom shadcn/ui implementation
- **Styling**: Tailwind CSS with custom design system optimized for Korean educational institutions
- **Design Philosophy**: Material Design + Custom Elements approach prioritizing data readability and mobile-first usability
- **Color System**: Custom light/dark mode with HSL color variables optimized for educational data display
- **Typography**: Noto Sans KR for Korean text, Inter for English/numbers
- **State Management**: TanStack React Query for server state management
- **Routing**: Wouter for lightweight client-side routing

### Backend Architecture
- **Runtime**: Node.js with Express.js framework
- **Language**: TypeScript with ES modules
- **API Pattern**: RESTful API with prefix `/api`
- **Database ORM**: Drizzle ORM for type-safe database operations
- **Schema Validation**: Zod schemas integrated with Drizzle for runtime validation
- **Session Management**: Express sessions with PostgreSQL session store
- **Authentication**: JWT-based authentication with role-based access control (SUPERADMIN, OWNER, TEACHER)

### Multi-Tenant Architecture
- **Tenant Isolation**: Database-level tenant separation using tenantId filtering
- **Approval Workflow**: Three-state tenant lifecycle (PENDING → ACTIVE → EXPIRED/SUSPENDED)
- **Access Control**: Hierarchical permission system with tenant-scoped data access
- **Admin Panel**: Superadmin interface for tenant approval and lifecycle management

### Data Storage Design
- **Primary Database**: PostgreSQL with Neon serverless hosting
- **Schema Design**: Tenant-isolated tables with comprehensive relationships
- **Key Entities**: Tenants, Users, Teachers, Classes, Students, Enrollments, Payments, LessonLogs
- **Business Logic**: Sibling discount calculation (10% for 2+ siblings), custom tuition rates, due date tracking

### Development Workflow
- **Build System**: Vite for frontend, esbuild for backend bundling
- **Development**: Hot reload with runtime error overlay
- **Deployment**: Production build outputs to `dist/` directory
- **Database Migrations**: Drizzle Kit for schema migrations and management

## External Dependencies

### Database Services
- **Neon Database**: Serverless PostgreSQL hosting with connection pooling
- **Connection Management**: @neondatabase/serverless with WebSocket support for serverless environments

### UI Component Libraries
- **Radix UI**: Comprehensive set of headless UI components for accessibility and functionality
- **Tailwind CSS**: Utility-first CSS framework with custom design tokens
- **Lucide React**: Icon library for consistent iconography

### Development Tools
- **TypeScript**: Type safety across frontend, backend, and shared schemas
- **React Query**: Server state management and caching
- **React Hook Form**: Form handling with Zod validation
- **Date-fns**: Date manipulation and formatting utilities

### Authentication & Security
- **express-session**: Session management middleware
- **connect-pg-simple**: PostgreSQL session store for persistent sessions
- **bcrypt**: Password hashing (implied for production use)

### Korean Localization
- **Google Fonts**: Noto Sans KR for Korean typography
- **Date/Time**: Korean locale support for educational calendar systems
- **Currency**: Korean Won (₩) formatting for tuition and payment display

### Production Infrastructure
- **Replit**: Development and hosting platform with integrated database provisioning
- **WebSocket**: Real-time connection support for serverless database access
- **Environment Variables**: Secure configuration management for database URLs and API keys