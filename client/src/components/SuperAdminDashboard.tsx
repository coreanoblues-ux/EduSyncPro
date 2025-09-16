import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Building2, Users, Check, Calendar } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Tenant {
  id: string;
  accountNumber: string;
  name: string;
  ownerName: string;
  ownerPhone: string;
  status: 'pending' | 'active' | 'expired' | 'suspended';
  activeUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function SuperAdminDashboard() {
  const { toast } = useToast();

  // 모든 테넌트 조회
  const { data: tenants = [], isLoading } = useQuery<Tenant[]>({
    queryKey: ['/api/superadmin/tenants'],
  });

  // 테넌트 승인 mutation
  const approveMutation = useMutation({
    mutationFn: async (tenantId: string) => {
      const response = await fetch(`/api/superadmin/tenants/${tenantId}/approve`, {
        method: 'PUT',
        credentials: 'include',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '승인 중 오류가 발생했습니다.');
      }
      
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "승인 완료",
        description: `${data.tenant.name}이 승인되었습니다.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/superadmin/tenants'] });
    },
    onError: (error: Error) => {
      toast({
        title: "승인 실패",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'pending': return 'outline';
      case 'active': return 'default';
      case 'expired': return 'secondary';
      case 'suspended': return 'destructive';
      default: return 'outline';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return '승인 대기';
      case 'active': return '활성';
      case 'expired': return '만료';
      case 'suspended': return '정지';
      default: return status;
    }
  };

  const pendingTenants = tenants.filter(t => t.status === 'pending');
  const activeTenants = tenants.filter(t => t.status === 'active');

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="text-lg font-semibold">테넌트 정보 로딩 중...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-2">
        <Building2 className="h-6 w-6" />
        <h1 className="text-2xl font-bold">슈퍼관리자 대시보드</h1>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">승인 대기</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingTenants.length}</div>
            <p className="text-xs text-muted-foreground">
              승인이 필요한 학원
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">활성 학원</CardTitle>
            <Check className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeTenants.length}</div>
            <p className="text-xs text-muted-foreground">
              운영 중인 학원
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">전체 학원</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{tenants.length}</div>
            <p className="text-xs text-muted-foreground">
              등록된 모든 학원
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 승인 대기 목록 */}
      {pendingTenants.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>승인 대기 학원</CardTitle>
            <CardDescription>
              다음 학원들이 승인을 기다리고 있습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {pendingTenants.map((tenant) => (
                <div
                  key={tenant.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                  data-testid={`tenant-pending-${tenant.id}`}
                >
                  <div className="space-y-1">
                    <div className="font-medium">{tenant.name}</div>
                    <div className="text-sm text-muted-foreground">
                      대표자: {tenant.ownerName} | 연락처: {tenant.ownerPhone}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      계정번호: {tenant.accountNumber} | 신청일: {new Date(tenant.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={getStatusBadgeVariant(tenant.status)}>
                      {getStatusText(tenant.status)}
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => approveMutation.mutate(tenant.id)}
                      disabled={approveMutation.isPending}
                      data-testid={`button-approve-${tenant.id}`}
                    >
                      {approveMutation.isPending ? '승인 중...' : '승인'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 전체 학원 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>전체 학원 목록</CardTitle>
          <CardDescription>
            시스템에 등록된 모든 학원을 확인할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {tenants.map((tenant) => (
              <div
                key={tenant.id}
                className="flex items-center justify-between p-4 border rounded-lg"
                data-testid={`tenant-all-${tenant.id}`}
              >
                <div className="space-y-1">
                  <div className="font-medium">{tenant.name}</div>
                  <div className="text-sm text-muted-foreground">
                    대표자: {tenant.ownerName} | 연락처: {tenant.ownerPhone}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    계정번호: {tenant.accountNumber} | 
                    {tenant.activeUntil && (
                      <span className="ml-1">
                        활성기간: {new Date(tenant.activeUntil).toLocaleDateString()}까지
                      </span>
                    )}
                  </div>
                </div>
                <Badge variant={getStatusBadgeVariant(tenant.status)}>
                  {getStatusText(tenant.status)}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}